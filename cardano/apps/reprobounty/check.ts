/**
 * Anyone can check a reproduction certificate: reads the CIP-20 record from
 * Cardano, finds the evidence bundle with the hash it names, checks the hash
 * and re-runs every verifier check locally.
 *
 *   npm run check -w apps/reprobounty -- <certificate tx hash>
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXPLORER_TX, blockfrost } from "@agentic/core";
import { verifyBundle } from "./agents/verifier.ts";
import { bundleHash, type EvidenceBundle } from "./lib/evidence.ts";

const tx = process.argv[2];
if (!tx || !/^[0-9a-f]{64}$/.test(tx)) {
  console.error("usage: npm run check -w apps/reprobounty -- <certificate tx hash>");
  process.exit(2);
}

const metadata = await blockfrost<{ label: string; json_metadata: { msg?: string[] } }[]>(`/txs/${tx}/metadata`);
const lines = metadata?.find((m) => m.label === "674")?.json_metadata.msg;
if (!lines) {
  console.error(`No CIP-20 record in ${tx} (not confirmed yet, or not a certificate).`);
  process.exit(1);
}
console.log(`Certificate on Cardano preprod: ${EXPLORER_TX}${tx}\n${lines.map((l) => `  | ${l}`).join("\n")}\n`);

const after = (label: string) => lines[lines.indexOf(label) + 1];
const evidenceHash = after("evidence sha256:");
const file = fileURLToPath(new URL(`./evidence/${evidenceHash}.json`, import.meta.url));
if (!evidenceHash || !existsSync(file)) {
  console.error(`Evidence bundle ${evidenceHash} not found in evidence/.`);
  process.exit(1);
}
const evidence = JSON.parse(readFileSync(file, "utf8")) as { bundle: EvidenceBundle; files: Record<string, string>; manuscript: string };
const recomputed = bundleHash(evidence.bundle);
console.log(`${recomputed === evidenceHash ? "✓" : "✗"} evidence/${evidenceHash.slice(0, 16)}….json hashes to the on-chain evidence hash`);
const report = verifyBundle({ task: evidence.bundle.task, bundle: evidence.bundle, bundleHash: evidenceHash, manuscript: evidence.manuscript, files: evidence.files }, "local check");
for (const c of report.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`);
const ok = recomputed === evidenceHash && report.passed;
console.log(`\n${ok ? "Certificate checks out" : "Certificate does NOT check out"}: ${evidence.bundle.comparison.verdict}, ${evidence.bundle.comparison.passed}/${evidence.bundle.comparison.total} checks.`);
process.exit(ok ? 0 : 1);
