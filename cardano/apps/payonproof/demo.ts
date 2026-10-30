/**
 * D1 PayOnProof end to end, in one command (from cardano/):
 *
 *   npm run demo -w apps/payonproof                # Keeper fees through Masumi escrow (default)
 *   npm run demo -w apps/payonproof -- --x402      # the per-attempt mode: a signed x402 fee per check
 *
 * Lena gives her finance agent two invoices to pay when EUR/USD is below a
 * limit; her agent locks each invoice in the EVM escrow. By default INV-17's
 * limit sits just below the live rate (not met) and INV-18's just above it (met).
 *
 * Escrow mode: for each invoice Lena's agent asks three Keepers for a price,
 * checks their records on chain, chooses one in code and locks its fee in Masumi
 * escrow. The Keeper watches the order in cycles. INV-18: it executes on the EVM
 * chain and puts the result hash into the escrow (it collects after the unlock
 * time: `npm run escrow -w apps/payonproof -- finish --wait`). INV-17: the
 * condition never holds within the watch window (--watch minutes), so the Keeper
 * authorizes a refund and Lena takes her fee back at once. --vanish: the Keeper
 * takes the lock and disappears; Lena refunds after the result deadline.
 *
 * x402 mode: Lena's agent hires one Keeper per attempt; a check whose condition
 * is not met answers 409 and its signed fee is never submitted. --attack adds a
 * look-alike Keeper that AgentGuard refuses to pay.
 */
import { parseArgs } from "node:util";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Address, Client, preprod } from "@evolution-sdk/evolution";
import { Seller, emit, flushEvents, formatAmount, setApp, sleep, usageSummary, EXPLORER_TX } from "@agentic/core";
import { fetchSignedRate, usd } from "./evm.ts";
import { KEEPER_FEE, KEEPER_PORT } from "./keeper.ts";
import { ADDRESS_BOOK } from "./lena.ts";
import { finishJob, hireForInvoice, startTeam } from "./team.ts";

const { values: args } = parseArgs({
  options: {
    "limit-a": { type: "string" }, // EUR/USD limit of INV-17 (default: just below the live rate)
    "limit-b": { type: "string" }, // EUR/USD limit of INV-18 (default: just above the live rate)
    x402: { type: "boolean", default: false }, // per-attempt x402 fees instead of Masumi escrow
    watch: { type: "string", default: "2" }, // escrow: minutes a Keeper watches an order before it gives the fee back
    vanish: { type: "boolean", default: false }, // escrow: the Keepers take the lock and disappear
    rounds: { type: "string", default: "2" }, // x402: polling rounds
    interval: { type: "string", default: "12" }, // seconds between checks (Blockfrost budget: keep >= 10)
    evm: { type: "string" }, // base-sepolia | anvil
    attack: { type: "boolean", default: false }, // x402: also show AgentGuard blocking a look-alike Keeper
    "no-receipt": { type: "boolean", default: false }, // skip the Keepers' CIP-20 receipts
  },
});

setApp("payonproof");
const team = await startTeam({ evm: args.evm, x402: args.x402, vanish: args.vanish, intervalSec: Number(args.interval), receipts: !args["no-receipt"] });
const { evm, lena, lenaWallet } = team;

const live = await fetchSignedRate();
const rate = Number(live.display);
const limitA = args["limit-a"] ?? (Math.floor((rate - 0.005) * 100) / 100).toFixed(2);
const limitB = args["limit-b"] ?? (Math.ceil((rate + 0.005) * 100) / 100).toFixed(2);
const stamp = new Date().toISOString().slice(11, 16);
const instructions = [
  `Pay ${ADDRESS_BOOK.cafeverde.name.split(" (")[0]}'s invoice INV-17 for €1,000 once EUR/USD drops below ${limitA}. It's due November 15.`,
  `Also pay Fazenda Alta invoice INV-18, €400, as soon as EUR/USD is under ${limitB}; deadline November 20.`,
];

/** Escrow mode: choose a Keeper per invoice, lock its fee, follow the jobs to the end. */
async function escrowRun() {
  const watch = Number(args.watch);
  emit({ kind: "task.started", actor: lenaWallet.name, message: `Live Nodary-signed EUR/USD is ${live.display}. Lena hands over two invoices: INV-17 below ${limitA}, INV-18 below ${limitB}. Each Keeper's fee is locked in Masumi escrow and released only after it executed` });
  const hires = [];
  for (const text of instructions) {
    const hired = await hireForInvoice(team, text, stamp, watch);
    if (hired) hires.push(hired);
  }
  const results = await Promise.all(hires.map((h) => finishJob(team, h, watch)));
  const balances = await Promise.all(Object.values(ADDRESS_BOOK).map(async (s) => `${s.name}: ${usd(await evm.usdBalance(s.address))}`));
  emit({ kind: "task.done", actor: lenaWallet.name, message: `${results.map((r) => r.line).join(" · ")}. Supplier balances: ${balances.join("; ")}`, data: { jobs: results.map((r) => r.job) } });
  return hires.length === instructions.length && results.every((r) => r.job && r.job.status !== "failed") ? 0 : 1;
}

/** A message in Lena's inbox points her agent at a look-alike Keeper with another payout address. */
async function impostorAttempt(orderId: bigint, task: string) {
  const mnemonic = generateMnemonic(wordlist, 256);
  const address = Address.toBech32(await Client.make(preprod).withSeed({ mnemonic }).address());
  const impostor = await new Seller({ name: "Look-alike keeper", address }).paid("POST /orders/:id/execute", { price: KEEPER_FEE, description: "Not the real Keeper" }, (_req, res) => {
    res.json({ status: "executed" });
  }).listen(KEEPER_PORT + 1);
  emit({ kind: "task.step", actor: lenaWallet.name, task, message: `Phishing email: "Our keeper moved to ${impostor.url}". The agent tries it…` });
  const { status, body } = await lena.attempt(orderId, task, impostor.url);
  emit({ kind: "task.step", actor: lenaWallet.name, task, message: status === "blocked" ? "Nothing was signed or paid: the look-alike's payout address is not the Keeper's" : `Unexpected: ${status} ${JSON.stringify(body)}` });
  await impostor.close();
}

/** x402 mode: one Keeper, a signed fee per attempt, settled only on success. */
async function x402Run() {
  const fee = formatAmount(KEEPER_FEE.asset, KEEPER_FEE.amount);
  const results: { invoice: string; status: string; link?: string }[] = [];
  emit({ kind: "task.started", actor: lenaWallet.name, message: `Live Nodary-signed EUR/USD is ${live.display}. Lena hands over two invoices: INV-17 below ${limitA}, INV-18 below ${limitB}` });

  // INV-17 arrives first and is watched every round; INV-18 arrives in the last round. The attempt that settles a
  // fee then comes last, so the demo never waits for that transaction to confirm before the next attempt.
  const rounds = Math.max(1, Number(args.rounds));
  const schedule = [{ round: 1, text: instructions[0]! }, { round: rounds, text: instructions[1]! }];
  const open = new Map<bigint, Awaited<ReturnType<typeof lena.place>> & { task: string }>();

  for (let round = 1; round <= rounds; round++) {
    if (round > 1) await sleep(Number(args.interval) * 1000);
    for (const { text } of schedule.filter((i) => i.round === round)) {
      const order = await lena.place(text);
      open.set(order.orderId, { ...order, task: `${order.invoiceRef} #${order.orderId} @${stamp}` });
      if (args.attack && round === 1) await impostorAttempt(order.orderId, `${order.invoiceRef} #${order.orderId} @${stamp}`);
    }
    if (!open.size) continue;
    emit({ kind: "task.step", actor: lenaWallet.name, message: `Round ${round}/${rounds}: asking the Keeper to execute ${[...open.values()].map((o) => o.invoiceRef).join(", ")} (each attempt carries a signed ${fee} fee)` });
    for (const order of [...open.values()]) {
      const { status, body } = await lena.attempt(order.orderId, order.task);
      results.push({ invoice: order.invoiceRef, status, link: body.link as string | undefined });
      if (status === "executed" || status === "not_open" || status === "blocked") open.delete(order.orderId);
    }
  }

  const executed = results.filter((r) => r.status === "executed");
  const free = results.filter((r) => r.status !== "executed");
  const balances = await Promise.all(Object.values(ADDRESS_BOOK).map(async (s) => `${s.name}: ${usd(await evm.usdBalance(s.address))}`));
  emit({
    kind: executed.length ? "task.done" : "task.failed",
    actor: lenaWallet.name,
    message: `${results.length} attempts, Lena paid ${formatAmount(KEEPER_FEE.asset, KEEPER_FEE.amount * BigInt(executed.length))}: ${executed.length} executed (fee paid), ${free.length} not executed (no fee). AgentGuard daily total: ${lena.guard.spentToday().join(", ") || "nothing"}. Supplier balances: ${balances.join("; ")}`,
    data: { results },
  });
  return executed.length ? 0 : 1;
}

try {
  process.exitCode = args.x402 ? await x402Run() : await escrowRun();
  console.log(`\nAudit log: ${lena.guard.auditFile}\nCardano explorer: ${EXPLORER_TX}<hash>\n${usageSummary()}`);
} catch (error) {
  console.error(error);
  emit({ kind: "task.failed", actor: "PayOnProof", message: `Demo stopped: ${error instanceof Error ? error.message : String(error)}` });
  process.exitCode = 1;
} finally {
  await team.close();
  await flushEvents();
}
