/**
 * Demo dashboard: event timeline, money-flow graph, cardanoscan links and the
 * AgentGuard kill switch. Events arrive by POST /events (other processes) or
 * directly when the dashboard runs inside the same process.
 *
 *   npm run dashboard        # http://127.0.0.1:4000
 */
import { readFileSync } from "node:fs";
import express, { type Response } from "express";
import { markLocalDashboard, onEvent, type AgentEvent } from "../events.ts";
import { freezeAll, frozenReason, unfreezeAll } from "../guard.ts";

const PAGE = new URL("./index.html", import.meta.url);

/**
 * Starts the dashboard on `port`. If another dashboard already listens there,
 * returns `embedded: false` and this process's events go to that one instead.
 */
export async function startDashboard(port = Number(process.env.DASHBOARD_PORT ?? 4000)): Promise<{ url: string; embedded: boolean }> {
  const url = `http://127.0.0.1:${port}`;
  const history: AgentEvent[] = [];
  const clients = new Set<Response>();
  const broadcast = (name: string, data: unknown) => {
    for (const client of clients) client.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const push = (event: AgentEvent) => {
    history.push(event);
    if (history.length > 5_000) history.shift();
    broadcast("agent-event", event);
  };

  const app = express();
  app.use(express.json());
  app.get("/", (_req, res) => {
    res.type("html").send(readFileSync(PAGE, "utf8"));
  });
  app.get("/stream", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    for (const event of history) res.write(`event: agent-event\ndata: ${JSON.stringify(event)}\n\n`);
    res.write(`event: freeze\ndata: ${JSON.stringify({ frozen: frozenReason() ?? null })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });
  app.post("/events", (req, res) => {
    push(req.body as AgentEvent);
    res.sendStatus(204);
  });
  app.post("/reset", (_req, res) => {
    history.length = 0;
    broadcast("reset", {});
    res.sendStatus(204);
  });
  app.post("/freeze", (_req, res) => {
    freezeAll("frozen from the dashboard");
    broadcast("freeze", { frozen: frozenReason() });
    res.json({ frozen: frozenReason() });
  });
  app.post("/unfreeze", (_req, res) => {
    unfreezeAll();
    broadcast("freeze", { frozen: null });
    res.json({ frozen: null });
  });
  setInterval(() => broadcast("ping", {}), 20_000).unref();

  const listener = app.listen(port, "127.0.0.1");
  const started = await new Promise<boolean>((resolve) => {
    listener.once("listening", () => resolve(true));
    listener.once("error", () => resolve(false));
  });
  if (!started) return { url, embedded: false };
  markLocalDashboard();
  onEvent(push);
  return { url, embedded: true };
}
