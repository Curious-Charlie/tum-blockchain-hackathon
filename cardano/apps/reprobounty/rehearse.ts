/**
 * Offline rehearsal: the same pipeline as the demo (Claude extraction, sandboxed
 * run, mapping, deterministic comparison, evidence bundle, verification) with
 * no wallets and no payments. For testing prompts and as a fallback when
 * preprod is slow.
 *
 *   npm run rehearse -w apps/reprobounty [-- --altered] [-- --tamper]
 */
import { usageSummary } from "@agentic/core";
import { executePackage } from "./agents/compute.ts";
import { buildBundle, extractClaims, fabricate, mapClaims, type ReproRequest } from "./agents/replicator.ts";
import { verifyBundle } from "./agents/verifier.ts";
import { compare, validateClaims, validateMappings } from "./lib/compare.ts";
import { parseCsv } from "./lib/evidence.ts";
import { DEMO_TARGET, PACKAGES, demoPaper } from "./registry.ts";

const altered = process.argv.includes("--altered");
const tamper = process.argv.includes("--tamper");
const paper = demoPaper(altered);
const pkg = PACKAGES[0]!;
const request: ReproRequest = { task: "rehearsal", paper, manuscript: paper.manuscript, code: { repo: pkg.repo, commit: pkg.commit }, target: DEMO_TARGET };

const extracted = await extractClaims(request.manuscript, request.target);
const { valid: claims, rejected } = validateClaims(extracted, request.manuscript);
console.log("claims:", claims.map((c) => `${c.id} ${c.symbol}=${c.value_text} (${c.applies_to})`));
if (rejected.length) console.log("rejected:", rejected);

let run = await executePackage(pkg, "addr_test_offline_compute");
console.log(`run: exit ${run.exitCode}, ${run.durationMs} ms, outputs ${run.outputs.map((o) => o.path).join(", ")}`);
const mapping = await mapClaims(claims, run);
console.log("mapping:", mapping.map((m) => `${m.claim_id} → ${m.file}:${m.column}`));
const tables = (r: typeof run) => Object.fromEntries(r.outputs.map((o) => [o.path, parseCsv(o.content)]));
const problems = validateMappings(claims, mapping, tables(run));
if (problems.length) throw new Error(problems.join("; "));
if (tamper) run = fabricate(run, claims, mapping);

const comparison = compare(claims, mapping, tables(run));
console.log(`verdict: ${comparison.verdict} ${comparison.passed}/${comparison.total} (truncation ${comparison.truncation}, rounding ${comparison.rounding})`);
console.table(comparison.claims);

const { bundle, hash, files } = buildBundle({ request, task: "rehearsal", pkg, run, claims, mapping, comparison, replicator: "addr_test_offline_replicator" });
const report = verifyBundle({ task: "rehearsal", bundle, bundleHash: hash, manuscript: request.manuscript, files }, "addr_test_offline_verifier");
console.log(`bundle ${hash}\nverification: ${report.passed ? "PASSED" : "FAILED"}`);
for (const c of report.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`);
console.log(usageSummary());
