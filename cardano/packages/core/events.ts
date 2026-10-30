/**
 * Event bus: who did what, who paid whom, how much, which transaction.
 *
 * Every event is printed to the console, delivered to in-process listeners and,
 * unless a dashboard runs in this process, POSTed to DASHBOARD_URL so a
 * dashboard in another terminal (npm run dashboard) shows it live.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { EXPLORER_TX } from "./config.ts";

export type EventKind =
  | "agent.online" //    an agent and its wallet address
  | "task.started"
  | "task.step"
  | "task.done"
  | "task.failed"
  | "guard.approved" //  AgentGuard let a payment through
  | "guard.blocked" //   AgentGuard refused a payment
  | "payment.held" //    seller verified a signed payment; it settles only if the work succeeds
  | "payment.settled" // transaction submitted on chain
  | "payment.voided" //  work failed, the signed payment was never submitted
  | "chain.published"; // CIP-20 record on chain

export interface AgentEvent {
  id: string;
  ts: string;
  app: string;
  kind: EventKind;
  /** Display name of the agent this event is about. */
  actor?: string;
  message: string;
  /** Payment edges use agent display names. */
  from?: string;
  to?: string;
  amount?: string;
  tx?: string;
  task?: string;
  data?: Record<string, unknown>;
}

export type EventInput = Omit<AgentEvent, "id" | "ts" | "app">;

const bus = new EventEmitter();
bus.setMaxListeners(100);
const pending = new Set<Promise<unknown>>();
let app = process.env.APP_NAME ?? "core";
let localDashboard = false;

export function setApp(name: string) {
  app = name;
}

export function appName() {
  return app;
}

/** Called by an in-process dashboard so events are not also POSTed. */
export function markLocalDashboard() {
  localDashboard = true;
}

export function onEvent(listener: (event: AgentEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

const ICON: Record<EventKind, string> = {
  "agent.online": "●", "task.started": "▶", "task.step": "·", "task.done": "✔", "task.failed": "✘",
  "guard.approved": "🛡", "guard.blocked": "⛔", "payment.held": "⏸", "payment.settled": "₳",
  "payment.voided": "↺", "chain.published": "⛓",
};

export function emit(input: EventInput): AgentEvent {
  const event: AgentEvent = { id: randomUUID(), ts: new Date().toISOString(), app, ...input };
  if (process.env.QUIET_EVENTS !== "1") {
    const who = event.actor ? `[${event.actor}] ` : "";
    console.log(`${ICON[event.kind]} ${who}${event.message}${event.tx ? `\n    ${EXPLORER_TX}${event.tx}` : ""}`);
  }
  bus.emit("event", event);
  if (!localDashboard) {
    const url = process.env.DASHBOARD_URL ?? "http://127.0.0.1:4000";
    const post = fetch(`${url}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined);
    pending.add(post);
    void post.finally(() => pending.delete(post));
  }
  return event;
}

/** Waits for in-flight dashboard POSTs, so a short script's last events arrive. */
export async function flushEvents() {
  await Promise.all(pending);
}
