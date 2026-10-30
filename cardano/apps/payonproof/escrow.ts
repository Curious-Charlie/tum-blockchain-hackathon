/**
 * The escrow steps that wait for a deadline, for Keeper jobs started by the demo:
 *
 *   npm run escrow -w apps/payonproof                    # status of every escrow job
 *   npm run escrow -w apps/payonproof -- finish          # do what is due now
 *   npm run escrow -w apps/payonproof -- finish --wait   # keep going until every job is closed
 *   npm run escrow -w apps/payonproof -- report          # every job and its transactions as a Markdown table
 *
 * Due means: a delivered job (result hash in the escrow) once its unlock time has
 * passed → the Keeper collects its fee; an undelivered job once its result
 * deadline has passed, or a job whose refund the Keeper authorized → Lena
 * withdraws her fee.
 */
import { ESCROW, EXPLORER_TX, Wallet, emit, flushEvents, setApp, sleep } from "@agentic/core";
import { collect, escrowOutputOf, listJobs, nextStep, record, withdrawRefund, type EscrowJob } from "@agentic/core/escrow";
import { roles } from "./roles.ts";

setApp("payonproof");
const args = process.argv.slice(2);
const command = args[0] ?? "status";
const wait = args.includes("--wait");
const at = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString([], { hourCycle: "h23" }) : "?");

const wallets = new Map<string, Wallet>();
const wallet = async (role: string) => {
  if (!wallets.has(role)) wallets.set(role, await Wallet.load(role, roles.find((r) => r.role === role)?.name ?? role));
  return wallets.get(role)!;
};
const open = (job: EscrowJob) => nextStep(job) !== undefined;

function status() {
  const jobs = listJobs().sort((a, b) => (a.history[0]?.at ?? "").localeCompare(b.history[0]?.at ?? ""));
  if (!jobs.length) console.log("No escrow jobs yet: npm run demo -w apps/payonproof");
  for (const job of jobs) {
    const next = nextStep(job);
    console.log(`${job.jobId.slice(0, 8)}  ${job.task.padEnd(26)} ${job.seller.padEnd(9)} ${job.status.padEnd(18)} ${next ? `${next.action} from ${at(next.at || Date.now())}` : ""}`);
    if (job.summary) console.log(`          ${job.summary}`);
    for (const h of job.history) console.log(`          ${h.action.padEnd(18)} ${EXPLORER_TX}${h.tx}`);
  }
}

async function finishOne(job: EscrowJob) {
  const next = nextStep(job);
  if (!next || Date.now() < next.at + 30_000) return false; // a little past the deadline: block times lag the clock
  const seller = await wallet(job.seller);
  const buyer = await wallet(job.buyer);
  const escrowUtxo = await escrowOutputOf(seller, job.escrowTx!);
  if (!escrowUtxo) throw new Error(`job ${job.jobId}: no escrow output in ${job.escrowTx}`);
  if (next.action === "collect") {
    const tx = await collect(seller, escrowUtxo);
    job.status = "collected";
    record(job, "collect", tx);
    emit({ kind: "payment.settled", actor: seller.name, task: job.task, from: ESCROW, to: seller.name, amount: job.amount, tx, message: `${seller.name} collected its ${job.amount} fee from the escrow (unlock time passed, no dispute)` });
  } else {
    const tx = await withdrawRefund(buyer, escrowUtxo);
    const why = job.status === "refund_authorized" ? `${seller.name} authorized the refund` : "no result reached the escrow before the deadline";
    job.status = "refunded";
    record(job, "withdraw_refund", tx);
    emit({ kind: "payment.settled", actor: buyer.name, task: job.task, from: ESCROW, to: buyer.name, amount: job.amount, tx, message: `${buyer.name} took its ${job.amount} back from the escrow: ${why}` });
  }
  return true;
}

async function finish() {
  const deadline = Date.now() + 60 * 60_000;
  for (;;) {
    for (const job of listJobs().filter(open)) {
      try {
        await finishOne(job);
      } catch (error) {
        console.error(`job ${job.jobId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const pending = listJobs().filter(open);
    if (!wait || !pending.length || Date.now() > deadline) {
      for (const job of pending) console.log(`${job.jobId.slice(0, 8)} ${job.status}: ${nextStep(job)?.action} from ${at(nextStep(job)?.at)}`);
      return;
    }
    const nextAt = Math.min(...pending.map((j) => nextStep(j)!.at)) + 30_000;
    console.log(`Next action at ${at(nextAt)}…`);
    await sleep(Math.max(30_000, Math.min(nextAt - Date.now(), 5 * 60_000)));
  }
}

/** A Markdown table of every job: who did it, what happened, every transaction on both chains. */
function report() {
  const link = (tx?: string) => (tx ? `[\`${tx.slice(0, 8)}…\`](${EXPLORER_TX}${tx})` : "");
  const evmLink = (tx?: string) => (tx ? `[\`${tx.slice(0, 10)}…\`](https://sepolia.basescan.org/tx/${tx})` : "");
  console.log("| Invoice | Keeper | Outcome | Fee lock | Execute (Base Sepolia) | Result hash in escrow | Receipt | Collect / refund |");
  console.log("|---|---|---|---|---|---|---|---|");
  const jobs = listJobs().filter((j) => j.lockTx).sort((a, b) => (a.history[0]?.at ?? "").localeCompare(b.history[0]?.at ?? ""));
  for (const job of jobs) {
    const tx = (action: string) => job.history.find((h) => h.action === action)?.tx;
    const keeper = roles.find((r) => r.role === job.seller)?.name ?? job.seller;
    // A Keeper that gave up writes why (summary); a vanished one writes nothing.
    const outcome = job.resultHash ? "executed" : job.summary ? `limit not reached${tx("authorize_refund") ? "" : " (refund after the deadline)"}` : "Keeper vanished";
    const end = tx("collect") ? `collect ${link(tx("collect"))}` : tx("withdraw_refund") ? `${tx("authorize_refund") ? `authorize ${link(tx("authorize_refund"))}, ` : ""}refund ${link(tx("withdraw_refund"))}` : job.status;
    const execute = (job.result as { executeTx?: string } | undefined)?.executeTx;
    console.log(`| ${job.task.split(" ")[0]} | ${keeper} (${job.amount}) | ${outcome} | ${link(job.lockTx)} | ${evmLink(execute)} | ${link(tx("submit_result"))} | ${link(job.receiptTx)} | ${end} |`);
  }
}

if (command === "report") report();
else {
  if (command === "finish") await finish();
  status();
}
await flushEvents();
