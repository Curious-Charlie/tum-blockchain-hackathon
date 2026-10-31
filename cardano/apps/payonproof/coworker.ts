/**
 * PayOnProof as a Sokosumi Coworker ("PayOnProof finance agent").
 *
 * A team posts a Task in its Sokosumi Workspace, in one sentence:
 *   "Pay Fazenda Alta invoice INV-18, €400, as soon as EUR/USD is under 1.13; deadline November 20."
 * This worker picks it up and runs Lena's finance agent on it: the invoice is
 * locked in the EVM escrow, a Keeper is chosen by price and on-chain record and
 * its fee locked in Masumi escrow, and the payment executes on an API3-signed
 * rate. The Task is completed with what happened and every transaction link.
 * Follow-up comments are answered from the job's facts; a comment never moves money.
 *
 *   npm run coworker -w apps/payonproof
 *
 * Needs the pinned CLI in sokosumi/ at the repo root (Node 24), `sokosumi/sk
 * --preprod auth login` (to list Tasks), the Coworker's runtime key in the OS
 * vault, and in this app's .env: COWORKER_ID, SOKOSUMI_ORGANIZATION_ID,
 * SOKOSUMI_ORGANIZATION_SLUG. Steps whose outcome is uncertain are not retried.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXPLORER_TX, HAIKU, ROOT, createMessage, emit, flushEvents, onEvent, setApp, sleep, textOf, type AgentEvent } from "@agentic/core";
import { loadJob } from "@agentic/core/escrow";
import { finishJob, hireForInvoice, startTeam } from "./team.ts";

setApp("payonproof");
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing in apps/payonproof/.env`);
  return value;
};
const coworkerId = required("COWORKER_ID");
const organizationId = required("SOKOSUMI_ORGANIZATION_ID");
const organizationSlug = required("SOKOSUMI_ORGANIZATION_SLUG");
const WATCH_MINUTES = Number(process.env.WATCH_MINUTES ?? 3);

const SOKOSUMI = path.resolve(ROOT, "..", "sokosumi");
const NODE24 = process.env.NODE24 ?? "/opt/homebrew/opt/node@24/bin/node";
const STATE_DIR = path.join(ROOT, ".cache", "sokosumi", "tasks");
const env = { ...process.env, COWORKER_ID: coworkerId, SOKOSUMI_ORGANIZATION_ID: organizationId };
const json = <T>(file: string, args: string[], input?: string): T =>
  JSON.parse(execFileSync(file, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 8 << 20, env, input })) as T;
/** The CLI: account login for listing Tasks, the Coworker's runtime key for start and complete. */
const sk = <T>(args: string[]) => json<T>(path.join(SOKOSUMI, "sk"), ["--preprod", ...args, "--json"]);
/** Task events and comments as the Coworker (sokosumi/runtime.mjs). */
const runtime = <T>(args: string[], input?: string) => json<T>(NODE24, [path.join(SOKOSUMI, "runtime.mjs"), ...args], input);
const short = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 240);

interface Task { id: string; status: string; name?: string; description?: string; coworkerId?: string; assigneeId?: string; organizationId?: string | null }
interface TaskState {
  phase: "starting" | "started" | "result-saved" | "completing" | "completed";
  name?: string;
  input?: string;
  result?: string;
  jobId?: string;
  answered: string[];
}
const statePath = (taskId: string) => path.join(STATE_DIR, `${taskId}.json`);
const load = (taskId: string) => (existsSync(statePath(taskId)) ? (JSON.parse(readFileSync(statePath(taskId), "utf8")) as TaskState) : undefined);
const save = (taskId: string, state: TaskState) => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(taskId), JSON.stringify(state, null, 2));
  return state;
};
const mine = (t: Task) => (t.coworkerId ?? t.assigneeId) === coworkerId && t.organizationId === organizationId;

// ---------------------------------------------------------------- the job

/** One line per thing that happened, with its transaction links, from the agents' events. */
function timeline(log: AgentEvent[]) {
  const relevant = (e: AgentEvent) =>
    ["payment.external", "payment.settled", "chain.published"].includes(e.kind) ||
    (e.kind === "task.done" && Boolean(e.tx)) ||
    (e.kind === "task.step" && /^(Claude read it|✓|✗|Buyer decision|Refund authorized)|second source agrees|: executing /.test(e.message));
  const lines = log.filter(relevant).map((e) => {
    const links = [e.tx ? `${EXPLORER_TX}${e.tx}` : "", e.link ?? ""].filter(Boolean);
    return `- ${e.message}${links.length ? `\n  ${links.join("\n  ")}` : ""}`;
  });
  return [...new Set(lines)].join("\n");
}

function report(headline: string, log: AgentEvent[], jobId?: string) {
  const job = jobId ? loadJob(jobId) : undefined;
  const at = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }) + " CET" : "?");
  const footer = job?.status === "result_submitted"
    ? `The Keeper's fee stays in Masumi escrow until ${at(job.unlockTime)} (your dispute window); then it collects.${job.receiptTx ? `\nCheck the receipt against both chains yourself: npm run check -w apps/payonproof -- ${job.receiptTx}` : ""}`
    : job?.status === "refunded" ? "Nothing was executed, so the Keeper's fee came back to you." : "";
  return [headline, "", "What happened:", timeline(log), "", footer, "Ask me about this payment in the comments; a comment never moves money."].filter((s) => s !== undefined).join("\n").trim();
}

async function work(taskId: string, input: string, team: Awaited<ReturnType<typeof startTeam>>): Promise<{ result: string; jobId?: string }> {
  const log: AgentEvent[] = [];
  const off = onEvent((e) => log.push(e));
  const stamp = new Date().toISOString().slice(11, 16);
  try {
    const hired = await hireForInvoice(team, input, stamp, WATCH_MINUTES);
    if (!hired) return { result: report("No Keeper could be hired for this invoice, so its fee was not locked and nothing was executed.", log) };
    try {
      runtime(["comment", taskId], `${hired.keeper.name} is hired for ${hired.invoice}; its fee is locked in Masumi escrow${hired.lockTx ? `: ${EXPLORER_TX}${hired.lockTx}` : ""}. It is now watching the API3-signed EUR/USD rate for up to ${WATCH_MINUTES} minutes.`);
    } catch (error) {
      console.error(`Progress comment failed: ${short(error)}`);
    }
    const { line, job } = await finishJob(team, hired, WATCH_MINUTES);
    // The receipt is published right after the result hash; wait for it so the Task names it.
    for (let i = 0; job?.status === "result_submitted" && !loadJob(hired.jobId)?.receiptTx && i < 30; i++) await sleep(3_000);
    return { result: report(`${line}.`, log, hired.jobId), jobId: hired.jobId };
  } catch (error) {
    return { result: report(`I stopped: ${short(error)}`, log) };
  } finally {
    off();
  }
}

// ---------------------------------------------------------------- comments

const SYSTEM = "You are PayOnProof's finance agent, replying in a Sokosumi Task thread to the team that hired you to pay an invoice. " +
  "Answer in two to five short sentences, using only the facts given, and quote transaction links from them when they help. " +
  "You cannot move money from a comment: for another payment or a change, ask them to post a new Task. If the facts do not answer the question, say so.";

async function answerComments(taskId: string, state: TaskState) {
  const { events } = runtime<{ events: { id: string; comment?: string; actor?: { type?: string } }[] }>(["events", taskId]);
  for (const event of events.filter((e) => e.actor?.type === "user" && e.comment?.trim())) {
    if (state.answered.includes(event.id)) continue;
    const job = state.jobId ? loadJob(state.jobId) : undefined;
    const now = job ? `Escrow job now: ${job.status}. ${job.summary ?? ""} Transactions: ${job.history.map((h) => `${h.action} ${EXPLORER_TX}${h.tx}`).join("; ")}. Unlock time: ${job.unlockTime ? new Date(job.unlockTime).toISOString() : "?"}.` : "";
    const message = await createMessage({
      model: HAIKU,
      max_tokens: 800,
      system: SYSTEM,
      messages: [{ role: "user", content: `Facts (now ${new Date().toISOString()}):\n${state.result}\n\n${now}\n\nThe team asks:\n${event.comment}` }],
    });
    runtime(["comment", taskId], textOf(message).trim());
    state.answered.push(event.id);
    save(taskId, state);
    console.log(`Answered comment ${event.id} on ${taskId}`);
  }
}

// ---------------------------------------------------------------- the loop

async function handle(task: Task, team: Awaited<ReturnType<typeof startTeam>>) {
  let state = load(task.id);
  const target = ["--coworker-id", coworkerId, "--organization-id", organizationId];
  if (task.status === "READY" && !state) {
    save(task.id, { phase: "starting", answered: [] });
    const started = sk<{ name?: string; description?: string; task?: { name?: string; description?: string } }>(["runtime", "start", task.id, ...target]);
    const input = started.description ?? started.task?.description ?? task.description;
    state = save(task.id, { phase: "started", name: started.name ?? started.task?.name ?? task.name, input, answered: [] });
    emit({ kind: "task.started", actor: "PayOnProof finance agent", message: `Sokosumi Task ${task.id.slice(0, 8)}: "${input}"` });
  }
  if (!state) return;
  if (state.phase === "starting" || state.phase === "completing") {
    console.error(`Task ${task.id}: ${state.phase} has an uncertain outcome; inspect it in Sokosumi, then fix ${statePath(task.id)}`);
    return;
  }
  if (state.phase === "started") {
    const { result, jobId } = await work(task.id, state.input ?? "", team);
    state = save(task.id, { ...state, phase: "result-saved", result, jobId });
  }
  if (state.phase === "result-saved") {
    const file = path.join(STATE_DIR, `${task.id}.txt`);
    writeFileSync(file, state.result ?? "");
    state = save(task.id, { ...state, phase: "completing" });
    sk(["runtime", "complete", task.id, ...target, "--result-file", file]);
    state = save(task.id, { ...state, phase: "completed" });
    console.log(`Completed Task ${task.id}`);
  }
  if (state.phase === "completed") await answerComments(task.id, state);
}

const team = await startTeam({ intervalSec: 12, receipts: true, crossCheck: true });
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopping = true; });
console.log(`PayOnProof Coworker ${coworkerId} running; Tasks from the "${organizationSlug}" Workspace`);
while (!stopping) {
  try {
    const { tasks } = sk<{ tasks: Task[] }>(["tasks", "list", "--coworker-id", coworkerId, "--organization-slug", organizationSlug]);
    for (const task of tasks.filter(mine)) {
      try {
        await handle(task, team);
      } catch (error) {
        console.error(`Task ${task.id} blocked: ${short(error)}`);
      }
    }
  } catch (error) {
    console.error(`Polling failed: ${short(error)}`);
  }
  for (let i = 0; i < 10 && !stopping; i++) await sleep(1_000);
}
await team.close();
await flushEvents();
