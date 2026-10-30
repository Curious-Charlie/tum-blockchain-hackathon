/**
 * D1 PayOnProof end to end, in one command:
 *
 *   npm run demo -w apps/payonproof                     # from cardano/
 *   npm run demo -w apps/payonproof -- --limit-a 1.11 --limit-b 1.13 --rounds 2 --evm anvil
 *
 * Lena gives her finance agent two invoices to pay when EUR/USD is below a
 * limit. Her agent locks both in the escrow and hires the Keeper per attempt
 * over x402 (Cardano preprod). By default INV-17's limit sits just below the live
 * rate (condition not met: HTTP 409, fee never submitted) and INV-18's just above
 * it (executed: escrow pays the supplier, fee settles on Cardano).
 */
import { parseArgs } from "node:util";
import { Wallet, emit, flushEvents, formatAmount, setApp, sleep, usageSummary, EXPLORER_TX } from "@agentic/core";
import { connectEvm, fetchSignedRate, usd } from "./evm.ts";
import { KEEPER_FEE, startKeeper } from "./keeper.ts";
import { ADDRESS_BOOK, LenaAgent } from "./lena.ts";

const { values: args } = parseArgs({
  options: {
    "limit-a": { type: "string" }, // EUR/USD limit of INV-17 (default: just below the live rate)
    "limit-b": { type: "string" }, // EUR/USD limit of INV-18 (default: just above the live rate)
    rounds: { type: "string", default: "2" },
    interval: { type: "string", default: "12" }, // seconds between polling rounds (Blockfrost budget: keep >= 10)
    evm: { type: "string" }, // base-sepolia | anvil
  },
});

setApp("payonproof");
const fee = formatAmount(KEEPER_FEE.asset, KEEPER_FEE.amount);

const evm = await connectEvm(args.evm);
const lenaWallet = (await Wallet.load("LENA", "Lena's finance agent")).online("hires the Keeper per attempt, pays only through AgentGuard");
const keeperWallet = (await Wallet.load("KEEPER", "Keeper agent")).online(`executes invoice orders on ${evm.name}; ${fee} per success, nothing per failed attempt`);
emit({ kind: "task.step", actor: "PayOnProof", message: `Invoice escrow on ${evm.name}: ${evm.addressLink(evm.escrow)} (checks Nodary's signature, request, freshness and the limit itself)` });

const keeper = await startKeeper(keeperWallet, evm);
const lena = new LenaAgent(lenaWallet, evm, { url: keeper.url, wallet: keeperWallet });

const results: { invoice: string; status: string; link?: string }[] = [];
try {
  const live = await fetchSignedRate();
  const rate = Number(live.display);
  const limitA = args["limit-a"] ?? (Math.floor((rate - 0.005) * 100) / 100).toFixed(2);
  const limitB = args["limit-b"] ?? (Math.ceil((rate + 0.005) * 100) / 100).toFixed(2);
  emit({ kind: "task.started", actor: lenaWallet.name, message: `Live Nodary-signed EUR/USD is ${live.display}. Lena hands over two invoices: INV-17 below ${limitA}, INV-18 below ${limitB}` });

  const orders = [
    await lena.place(`Pay ${ADDRESS_BOOK.cafeverde.name.split(" (")[0]}'s invoice INV-17 for €1,000 once EUR/USD drops below ${limitA}. It's due November 15.`),
    await lena.place(`Also pay Fazenda Alta invoice INV-18, €400, as soon as EUR/USD is under ${limitB}; deadline November 20.`),
  ];
  const stamp = new Date().toISOString().slice(11, 16);
  const open = new Map(orders.map((order) => [order.orderId, { ...order, task: `${order.invoiceRef} #${order.orderId} @${stamp}` }]));

  const rounds = Number(args.rounds);
  for (let round = 1; round <= rounds && open.size; round++) {
    if (round > 1) await sleep(Number(args.interval) * 1000);
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
    message: `${results.length} attempts: ${executed.length} executed (fee paid), ${free.length} not executed (no fee). Spent today via AgentGuard: ${lena.guard.spentToday().join(", ") || "nothing"}. Supplier balances: ${balances.join("; ")}`,
    data: { results },
  });
  console.log(`\nAudit log: ${lena.guard.auditFile}\nCardano explorer: ${EXPLORER_TX}<hash>\n${usageSummary()}`);
} catch (error) {
  emit({ kind: "task.failed", actor: "PayOnProof", message: `Demo stopped: ${error instanceof Error ? error.message : String(error)}` });
  process.exitCode = 1;
} finally {
  await keeper.close();
  evm.close();
  await flushEvents();
}
