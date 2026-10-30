/**
 * The PayOnProof agents in one process: Lena's finance agent and three Keepers
 * that sell the same job at different prices, plus the escrow-mode steps that
 * the demo and the autopilot share.
 */
import { EXPLORER_TX, Wallet, emit, formatAmount, usdm } from "@agentic/core";
import type { EscrowJob } from "@agentic/core/escrow";
import { connectEvm } from "./evm.ts";
import { KEEPER_FEE, KEEPER_PORT, KEEPER_ROLES, startKeeper } from "./keeper.ts";
import { LenaAgent, type Hired } from "./lena.ts";
import { roles } from "./roles.ts";

/** Escrow fee per watch job, in tUSDM. */
export const KEEPERS = [
  { role: "KEEPER", port: KEEPER_PORT, fee: usdm(2) },
  { role: "KEEPER_B", port: KEEPER_PORT + 2, fee: usdm(1) },
  { role: "KEEPER_C", port: KEEPER_PORT + 3, fee: usdm(4) },
] as const;

const nameOf = (role: string) => roles.find((r) => r.role === role)!.name;

export async function startTeam(options: { evm?: string; x402?: boolean; vanish?: boolean; intervalSec: number; receipts: boolean }) {
  const evm = await connectEvm(options.evm, [...KEEPER_ROLES]);
  const lenaWallet = (await Wallet.load("LENA", nameOf("LENA"))).online(options.x402 ? "hires the Keeper per attempt, pays only through AgentGuard" : "chooses a Keeper per invoice, locks its fee in Masumi escrow through AgentGuard");
  emit({ kind: "task.step", actor: "PayOnProof", message: `Invoice escrow on ${evm.name} ${evm.escrow}: checks Nodary's signature, request, freshness and the limit itself`, link: evm.explorer ? evm.addressLink(evm.escrow) : undefined, linkLabel: "contract on basescan ↗" });

  // Per-attempt mode keeps the original single Keeper.
  const keepers = await Promise.all(KEEPERS.filter((k) => !options.x402 || k.role === "KEEPER").map(async (spec) => {
    const fee = formatAmount(spec.fee.asset, spec.fee.amount);
    const wallet = (await Wallet.load(spec.role, nameOf(spec.role))).online(options.x402
      ? `executes invoice orders on ${evm.name}; ${formatAmount(KEEPER_FEE.asset, KEEPER_FEE.amount)} per success, nothing per failed attempt`
      : `watches invoice orders and executes them on ${evm.name}; ${fee} per job, locked in Masumi escrow${options.vanish ? " (DEMO: vanishes)" : ""}`);
    const server = await startKeeper(wallet, evm, { port: spec.port, escrowFee: spec.fee, intervalSec: options.intervalSec, vanish: options.vanish, receipts: options.receipts });
    return { spec, wallet, server };
  }));
  const lena = new LenaAgent(lenaWallet, evm, keepers.map((k) => ({ role: k.spec.role, name: k.wallet.name, url: k.server.url, address: k.wallet.address })));

  return {
    evm,
    lena,
    lenaWallet,
    keepers,
    async close() {
      for (const k of keepers) await k.server.idle();
      for (const k of keepers) await k.server.close();
      evm.close();
    },
  };
}

export type Team = Awaited<ReturnType<typeof startTeam>>;

/** One invoice in escrow mode: Lena's sentence → order in the EVM escrow → Keeper chosen → fee locked. */
export async function hireForInvoice(team: Team, instruction: string, stamp: string, watchMinutes: number): Promise<(Hired & { invoice: string }) | undefined> {
  const { lena } = team;
  const order = await lena.place(instruction);
  const task = `${order.invoiceRef} #${order.orderId} @${stamp}`;
  const keeper = await lena.chooseKeeper(order, task, watchMinutes);
  const hired = keeper && (await lena.hire(order.orderId, keeper, task, watchMinutes));
  if (!hired) return undefined;
  console.log(`${order.invoiceRef}: ${keeper.name} hired, ${formatAmount(keeper.asset, keeper.amount)} locked in Masumi escrow${hired.lockTx ? `\n  ${EXPLORER_TX}${hired.lockTx}` : ""}`);
  return { ...hired, invoice: order.invoiceRef };
}

/** Follows a hired job to its end; withdraws Lena's refund when the Keeper gives up. Returns one line. */
export async function finishJob(team: Team, hired: Hired & { invoice: string }, watchMinutes: number): Promise<{ line: string; job?: EscrowJob }> {
  const { lena, lenaWallet } = team;
  const { invoice, keeper } = hired;
  const job = await lena.follow(hired, (watchMinutes + 8) * 60_000);
  const at = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString([], { hourCycle: "h23" }) : "?");
  if (!job) return { line: `${invoice}: no answer from ${keeper.name}` };
  if (job.status === "result_submitted") {
    console.log(`\n${job.summary}\n  result hash ${job.resultHash}\n  result tx ${EXPLORER_TX}${job.escrowTx}\n  ${keeper.name} collects from ${at(job.unlockTime)}: npm run escrow -w apps/payonproof -- finish --wait`);
    return { job, line: `${invoice}: executed by ${keeper.name}, result hash in the escrow, fee collectable from ${at(job.unlockTime)}` };
  }
  if (job.status === "refund_authorized") {
    const tx = await lena.refund(job, `${keeper.name} authorized the refund (${job.summary})`);
    console.log(`\n${invoice}: ${job.summary}. Refund: ${EXPLORER_TX}${tx}`);
    return { job, line: `${invoice}: not executed (${job.summary}), Lena took her fee back` };
  }
  if (job.status === "vanished" || job.status === "locked" || job.status === "working") {
    emit({ kind: "task.step", actor: lenaWallet.name, task: job.task, message: `No result reached the escrow. Lena can take her ${job.amount} back from ${at(job.submitResultTime)} (the result deadline)` });
    console.log(`\n${invoice}: ${keeper.name} did not deliver. Refundable from ${at(job.submitResultTime)}: npm run escrow -w apps/payonproof -- finish --wait`);
    return { job, line: `${invoice}: ${keeper.name} did not deliver; Lena can refund from ${at(job.submitResultTime)}` };
  }
  return { job, line: `${invoice}: job ${job.status}${job.error ? ` (${job.error})` : ""}` };
}
