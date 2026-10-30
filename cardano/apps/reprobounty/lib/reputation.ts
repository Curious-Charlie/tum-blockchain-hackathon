/**
 * The Replicator's ledger of compute agents: runs it bought and how many passed
 * the Verifier. It starts from `reputation.seed.json` (a made-up history so the
 * demo has agents with different records; labelled as such everywhere) and every
 * real run adds to it in cardano/.cache/reputation.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "@agentic/core";
import type { TrackRecord } from "./market.ts";

const SEED = new URL("../reputation.seed.json", import.meta.url);
const LEDGER = path.join(ROOT, ".cache", "reputation.json");

export function loadRecords(): Record<string, TrackRecord> {
  const file = existsSync(LEDGER) ? LEDGER : SEED;
  const { providers } = JSON.parse(readFileSync(file, "utf8")) as { providers: Record<string, TrackRecord> };
  return providers;
}

export function addRun(role: string, verified: boolean) {
  const providers = loadRecords();
  const record = (providers[role] ??= { runs: 0, verified: 0 });
  record.runs += 1;
  if (verified) record.verified += 1;
  mkdirSync(path.dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify({ note: "seed + live runs", providers }, null, 2));
}
