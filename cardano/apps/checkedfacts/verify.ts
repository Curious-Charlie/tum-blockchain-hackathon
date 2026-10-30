/**
 * The shop owner's own audit of a report, against Cardano: reads the
 * fact-check certificate (CIP-20 metadata) and checks that it was published by
 * the checker wallet named in the report, that it is about this task, and that
 * its claims hash matches exactly the claims the shop owner received.
 *
 *   npm run verify -w apps/checkedfacts                       # latest saved run
 *   npm run verify -w apps/checkedfacts -- <report.json>      # a specific one (cardano/.cache/checkedfacts/)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { EXPLORER_TX, ROOT, blockfrost, waitForTx } from "@agentic/core";
import { claimsHash, type Claim } from "./verdict.ts";

interface Saved {
  task?: string;
  status: number;
  claims?: Claim[];
  certificate?: string;
  checker?: { name: string; address: string };
}

const dir = path.join(ROOT, ".cache", "checkedfacts");
const file = process.argv[2]
  ?? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f))
    .filter((f) => (JSON.parse(readFileSync(f, "utf8")) as Saved).certificate)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!file) throw new Error("No saved run with a certificate yet: run the demo first");
const report = JSON.parse(readFileSync(file, "utf8")) as Saved;
if (!report.certificate || !report.claims || !report.checker) throw new Error(`${file} has no certificate`);

const tx = report.certificate;
console.log(`Report ${path.basename(file)} (HTTP ${report.status}), certificate ${EXPLORER_TX}${tx}`);
await waitForTx(tx); // a fresh certificate may still be in the mempool
const metadata = await blockfrost<{ label: string; json_metadata: { msg?: string[] } }[]>(`/txs/${tx}/metadata`);
const lines = metadata?.find((m) => m.label === "674")?.json_metadata.msg ?? [];
const utxos = await blockfrost<{ inputs: { address: string }[] }>(`/txs/${tx}/utxos`);
console.log(`\nOn chain (label 674):\n${lines.map((l) => `  ${l}`).join("\n")}\n`);

const hash = lines.find((l) => l.startsWith("claims sha256 "))?.slice("claims sha256 ".length);
const verdict = lines.find((l) => l.startsWith("verdict "));
const checks: [string, boolean][] = [
  [`published by the checker wallet ${report.checker.name}`, !!utxos?.inputs.length && utxos.inputs.every((i) => i.address === report.checker!.address)],
  [`about this order (${report.task ?? "task unknown"})`, !!report.task && lines.includes(`task ${report.task}`)],
  ["claims hash matches the claims I received", !!hash && claimsHash(report.claims).startsWith(hash)],
];
for (const [label, ok] of checks) console.log(`${ok ? "✔" : "✘"} ${label}`);
const valid = checks.every(([, ok]) => ok);
console.log(`\n${valid ? "Certificate is genuine" : "Certificate does NOT match"}: ${verdict ?? "no verdict line"}`);
process.exitCode = valid ? 0 : 1;
