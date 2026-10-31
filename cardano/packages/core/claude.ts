/**
 * Claude helpers: Sonnet for main agents, Haiku for cheap helpers.
 *
 * - Every request is cached on disk by its full content (cardano/.cache/claude),
 *   so reruns and live demos are fast, stable and free. CLAUDE_CACHE=0 disables it.
 * - `runAgent` is a small tool-use loop; `askJson` returns schema-checked JSON.
 * - Sonnet requests opt into server-side refusal fallbacks (`fallbacks: "default"`).
 * - `usageSummary()` reports calls and estimated cost (budget is $200).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam, BetaToolUnion, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ROOT } from "./config.ts";

export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";
export type Model = typeof SONNET | typeof HAIKU;
type Effort = "low" | "medium" | "high";

/** $ per million tokens: input, output. */
const PRICES: Record<Model, [number, number]> = { [SONNET]: [2, 10], [HAIKU]: [0.1, 0.5] };
const CACHE_DIR = path.join(ROOT, ".cache", "claude");
const usage = { calls: 0, cached: 0, usd: 0 };

let client: Anthropic | undefined;
export const anthropic = () => (client ??= new Anthropic());

export function usageSummary() {
  return `${usage.calls} Claude calls (${usage.cached} from cache), about $${usage.usd.toFixed(3)}`;
}

type Params = Omit<MessageCreateParamsNonStreaming, "model"> & { model: Model };

/** messages.create with the disk cache, prompt caching and (Sonnet) refusal fallbacks. */
export async function createMessage(params: Params): Promise<BetaMessage> {
  const request: MessageCreateParamsNonStreaming = {
    cache_control: { type: "ephemeral" },
    ...(params.model === SONNET ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    ...params,
  };
  const file = path.join(CACHE_DIR, `${createHash("sha256").update(JSON.stringify(request)).digest("hex")}.json`);
  usage.calls++;
  if (process.env.CLAUDE_CACHE !== "0" && existsSync(file)) {
    usage.cached++;
    return JSON.parse(readFileSync(file, "utf8")) as BetaMessage;
  }
  const message = await anthropic().beta.messages.create(request);
  const [inPrice, outPrice] = PRICES[params.model];
  const u = message.usage;
  const inputTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  usage.usd += (inputTokens * inPrice + u.output_tokens * outPrice) / 1e6;
  if (message.stop_reason === "refusal") throw new Error(`Claude declined the request (${message.stop_details?.category ?? "no category"})`);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(message));
  return message;
}

export const textOf = (message: BetaMessage) =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();

export interface AgentTool<Input = Record<string, unknown>> {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (input: Input) => Promise<unknown>;
}

/** Declares a tool with a typed `run`. */
export const tool = <Input>(definition: AgentTool<Input>) => definition as unknown as AgentTool;

export interface AgentRun {
  text: string;
  messages: BetaMessageParam[];
  final: BetaMessage;
}

/**
 * Tool-use loop: calls tools until Claude ends its turn. Tool errors go back to
 * Claude as `is_error` results (e.g. a refused payment), so it can react.
 */
export async function runAgent(options: {
  model: Model;
  system: string;
  prompt: string;
  tools?: AgentTool[];
  /** Anthropic-hosted tools, e.g. web search. */
  serverTools?: BetaToolUnion[];
  effort?: Effort;
  maxTurns?: number;
}): Promise<AgentRun> {
  const tools = options.tools ?? [];
  const messages: BetaMessageParam[] = [{ role: "user", content: options.prompt }];
  for (let turn = 0; turn < (options.maxTurns ?? 12); turn++) {
    const final = await createMessage({
      model: options.model,
      max_tokens: 16_000,
      system: options.system,
      output_config: { effort: options.effort ?? "medium" },
      tools: [...(options.serverTools ?? []), ...tools.map(({ run: _run, ...definition }) => definition)],
      messages,
    });
    messages.push({ role: "assistant", content: final.content });
    if (final.stop_reason === "pause_turn") continue;
    if (final.stop_reason !== "tool_use") return { text: textOf(final), messages, final };

    const calls = final.content.filter((block) => block.type === "tool_use");
    const results = await Promise.all(calls.map(async (call) => {
      const handler = tools.find((t) => t.name === call.name);
      try {
        if (!handler) throw new Error(`Unknown tool ${call.name}`);
        const output = await handler.run(call.input as Record<string, unknown>);
        return { type: "tool_result" as const, tool_use_id: call.id, content: typeof output === "string" ? output : JSON.stringify(output) };
      } catch (error) {
        return { type: "tool_result" as const, tool_use_id: call.id, content: error instanceof Error ? error.message : String(error), is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  throw new Error(`Agent did not finish within ${options.maxTurns ?? 12} turns`);
}

/** One request whose answer must match `schema` (structured outputs). */
export async function askJson<T>(options: {
  model: Model;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  effort?: Effort;
}): Promise<T> {
  const message = await createMessage({
    model: options.model,
    max_tokens: 16_000,
    system: options.system,
    output_config: { effort: options.effort ?? "low", format: { type: "json_schema", schema: options.schema } },
    messages: [{ role: "user", content: options.prompt }],
  });
  return JSON.parse(textOf(message)) as T;
}

/** Hosted web search for research agents. */
export const webSearch = (maxUses = 5): BetaToolUnion => ({ type: "web_search_20260209", name: "web_search", max_uses: maxUses });
export const webFetch = (maxUses = 10): BetaToolUnion => ({ type: "web_fetch_20260209", name: "web_fetch", max_uses: maxUses });
