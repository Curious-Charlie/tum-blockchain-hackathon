/**
 * Hashing and the evidence bundle format. Everything here is deterministic:
 * the same files always give the same hashes on every agent.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Comparison, Mapping, ValidClaim } from "./compare.ts";

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** JSON with sorted keys, so a hash does not depend on key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface FileHash {
  path: string;
  sha256: string;
}

/** Hashes every file under `dir`; the tree hash covers paths and contents (like a git tree). */
export function hashTree(dir: string): { sha256: string; files: FileHash[] } {
  const files: FileHash[] = [];
  const walk = (sub: string) => {
    for (const name of readdirSync(path.join(dir, sub)).sort()) {
      if (name.startsWith(".") || name === "__pycache__" || name === "results") continue;
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(path.join(dir, rel)).isDirectory()) walk(rel);
      else files.push({ path: rel, sha256: sha256(readFileSync(path.join(dir, rel))) });
    }
  };
  walk("");
  return { sha256: sha256(files.map((f) => `${f.sha256}  ${f.path}\n`).join("")), files };
}

/** Parses a small CSV without quoting (our outputs). */
export function parseCsv(text: string): Record<string, string>[] {
  const [header, ...rows] = text.trim().split("\n").map((line) => line.split(","));
  return rows.map((row) => Object.fromEntries(header!.map((key, i) => [key, row[i] ?? ""])));
}

export interface EvidenceBundle {
  schema: "reprobounty/evidence@1";
  task: string;
  paper: { doi: string; title: string; manuscriptSha256: string };
  target: string;
  code: { repo: string; commit: string; license: string; packageSha256: string; files: FileHash[] };
  run: { command: string; exitCode: number; durationMs: number; environment: string; computeAgent: string; paymentTx?: string };
  outputs: FileHash[];
  log: FileHash;
  claims: ValidClaim[];
  mapping: Mapping[];
  comparison: Comparison;
  replicator: string;
  createdAt: string;
}

export const bundleHash = (bundle: EvidenceBundle) => sha256(canonical(bundle));
