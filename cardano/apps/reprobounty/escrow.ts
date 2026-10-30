/**
 * The escrow steps that wait for a deadline, for jobs started with
 * `npm run demo -w apps/reprobounty -- --escrow`:
 *
 *   npm run escrow -w apps/reprobounty                    # status of every escrow job
 *   npm run escrow -w apps/reprobounty -- finish          # do what is due now
 *   npm run escrow -w apps/reprobounty -- finish --wait   # keep going until every job is closed
 *
 * Due means: a delivered job (result hash in the escrow) once its unlock time has
 * passed → the Replicator collects; an undelivered job once its submit-result
 * deadline has passed, or a job whose refund the Replicator authorized → the
 * journal withdraws its refund.
 */
import { ESCROW, EXPLORER_TX, Wallet, emit, flushEvents, setApp, sleep } from "@agentic/core";
import { collect, escrowOutputOf, listJobs, record, withdrawRefund, type EscrowJob } from "./lib/escrow.ts";

setApp("reprobounty");
const args = process.argv.slice(2);
const command = args[0] ?? "status";
const wait = args.includes("--wait");
const at = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString() : "?");

const [requester, replicator] = await Promise.all([
  Wallet.load("REQUESTER", "Requester (journal)"),
  Wallet.load("REPLICATOR", "Replicator agent"),
]);

const open = (job: EscrowJob) => ["locked", "vanished", "result_submitted", "refund_authorized"].includes(job.status);

/** When the next action on `job` becomes possible (ms), and who takes it. */
function due(job: EscrowJob): { at: number; action: "collect" | "refund" } | undefined {
  if (job.status === "result_submitted") return { at: job.unlockTime!, action: "collect" };
  if (job.status === "refund_authorized") return { at: 0, action: "refund" };
  if (job.status === "locked" || job.status === "vanished") return { at: job.submitResultTime!, action: "refund" };
  return undefined;
}

function status() {
  const jobs = listJobs().sort((a, b) => (a.history[0]?.at ?? "").localeCompare(b.history[0]?.at ?? ""));
  if (!jobs.length) console.log("No escrow jobs yet: npm run demo -w apps/reprobounty -- --escrow");
  for (const job of jobs) {
    const next = due(job);
    console.log(`${job.jobId.slice(0, 8)}  ${job.task.padEnd(34)} ${job.status.padEnd(18)} ${next ? `${next.action} from ${at(next.at || Date.now())}` : ""}`);
    for (const h of job.history) console.log(`          ${h.action.padEnd(18)} ${EXPLORER_TX}${h.tx}`);
  }
}

async function finishOne(job: EscrowJob) {
  const next = due(job);
  if (!next || Date.now() < next.at + 30_000) return false; // a little past the deadline: block times lag the clock
  const escrowUtxo = await escrowOutputOf(replicator, job.escrowTx!);
  if (!escrowUtxo) throw new Error(`job ${job.jobId}: no escrow output in ${job.escrowTx}`);
  if (next.action === "collect") {
    const tx = await collect(replicator, escrowUtxo);
    job.status = "collected";
    record(job, "collect", tx);
    emit({ kind: "payment.settled", actor: replicator.name, task: job.task, from: ESCROW, to: replicator.name, amount: job.amount, tx, message: `${replicator.name} collected the ${job.amount} bounty from the escrow (unlock time passed, no dispute)` });
  } else {
    const tx = await withdrawRefund(requester, escrowUtxo);
    const why = job.status === "refund_authorized" ? "the Replicator authorized the refund" : "no result reached the escrow before the deadline";
    job.status = "refunded";
    record(job, "withdraw_refund", tx);
    emit({ kind: "payment.settled", actor: requester.name, task: job.task, from: ESCROW, to: requester.name, amount: job.amount, tx, message: `${requester.name} took its ${job.amount} back from the escrow: ${why}` });
  }
  return true;
}

async function finish() {
  const deadline = Date.now() + 60 * 60_000;
  for (;;) {
    const jobs = listJobs().filter(open);
    if (!jobs.length) return console.log("Every escrow job is closed.");
    for (const job of jobs) {
      try {
        await finishOne(job);
      } catch (error) {
        console.error(`job ${job.jobId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const pending = listJobs().filter(open);
    if (!wait || !pending.length || Date.now() > deadline) {
      for (const job of pending) console.log(`${job.jobId.slice(0, 8)} ${job.status}: ${due(job)?.action} from ${at(due(job)?.at)}`);
      return;
    }
    const nextAt = Math.min(...pending.map((j) => due(j)!.at)) + 30_000;
    console.log(`Next action at ${at(nextAt)}…`);
    await sleep(Math.max(30_000, Math.min(nextAt - Date.now(), 5 * 60_000)));
  }
}

if (command === "finish") await finish();
status();
await flushEvents();
