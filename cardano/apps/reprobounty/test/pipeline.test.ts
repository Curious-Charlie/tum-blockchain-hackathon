/**
 * Deterministic parts of ReproBounty, without Claude, wallets or network:
 * claim validation, comparison and verdict, and the Verifier's checks
 * (honest bundle passes, fabricated or re-hashed bundles fail).
 *
 *   npm test -w apps/reprobounty
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { executePackage } from "../agents/compute.ts";
import { buildBundle, fabricate, type ReproRequest } from "../agents/replicator.ts";
import { verifyBundle } from "../agents/verifier.ts";
import { compare, validateClaims, type ExtractedClaim, type Mapping } from "../lib/compare.ts";
import { parseCsv, sha256 } from "../lib/evidence.ts";
import { DEMO_TARGET, PACKAGES, demoPaper } from "../registry.ts";

const FILE = "results/summary_DatasaurusDozen.csv";
const STATS = [["x_mean", "x̄", "54.26"], ["y_mean", "ȳ", "47.83"], ["x_sd", "sd_x", "16.76"], ["y_sd", "sd_y", "26.93"], ["pearson_r", "Pearson's r", "-0.06"]];

function claimsFor(r: string): ExtractedClaim[] {
  return STATS.map(([column, symbol, value]) => {
    const v = column === "pearson_r" ? r : value!;
    return { id: `fig6_${column}`, description: column!, symbol: symbol!, value_text: v, applies_to: "Figure 6 datasets", quote: `${symbol} = ${v}` };
  });
}
const mapping: Mapping[] = STATS.map(([column]) => ({ claim_id: `fig6_${column}`, file: FILE, column: column!, reason: "" }));
const pkg = PACKAGES[0]!;
const run = await executePackage(pkg, "addr_test_compute");
const tables = (r: typeof run) => Object.fromEntries(r.outputs.map((o) => [o.path, parseCsv(o.content)]));

function setup(altered: boolean) {
  const paper = demoPaper(altered);
  const request: ReproRequest = { task: "t", paper, manuscript: paper.manuscript, code: { repo: pkg.repo, commit: pkg.commit }, target: DEMO_TARGET };
  const { valid, rejected } = validateClaims(claimsFor(altered ? "-0.60" : "-0.06"), paper.manuscript);
  assert.equal(rejected.length, 0);
  return { request, claims: valid };
}

test("the package runs and writes both summary tables", () => {
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.outputs.map((o) => o.path), ["results/summary_DatasaurusDozen.csv", "results/summary_TwelveFromSlant.csv"]);
});

test("a number that is not printed in the manuscript is rejected", () => {
  const { valid, rejected } = validateClaims([{ ...claimsFor("-0.06")[0]!, value_text: "54.99", quote: "x̄ = 54.99" }], demoPaper(false).manuscript);
  assert.equal(valid.length, 0);
  assert.match(rejected[0]!.reason, /not printed/);
});

test("the real paper is REPRODUCED; the paper truncates", () => {
  const { claims } = setup(false);
  const c = compare(claims, mapping, tables(run));
  assert.equal(c.verdict, "REPRODUCED");
  assert.equal(c.passed, 65);
  assert.equal(c.truncation, 65);
  assert.ok(c.rounding < 65);
});

test("the altered paper (r = -0.60) is NOT REPRODUCED and the honest bundle still verifies", () => {
  const { request, claims } = setup(true);
  const comparison = compare(claims, mapping, tables(run));
  assert.equal(comparison.verdict, "NOT REPRODUCED");
  assert.equal(comparison.passed, 52);
  const { bundle, hash, files } = buildBundle({ request, task: "t", pkg, run, claims, mapping, comparison, replicator: "r" });
  assert.equal(verifyBundle({ task: "t", bundle, bundleHash: hash, manuscript: request.manuscript, files }, "v").passed, true);
});

test("a fabricated results table fails the verifier's re-run", () => {
  const { request, claims } = setup(true);
  const fake = fabricate(run, claims, mapping);
  const comparison = compare(claims, mapping, tables(fake));
  assert.equal(comparison.verdict, "REPRODUCED");
  const { bundle, hash, files } = buildBundle({ request, task: "t", pkg, run: fake, claims, mapping, comparison, replicator: "r" });
  const report = verifyBundle({ task: "t", bundle, bundleHash: hash, manuscript: request.manuscript, files }, "v");
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks.filter((c) => !c.ok).map((c) => c.name), ["re-run: statistics follow from the pinned data"]);
});

test("an edited output file or a wrong verdict is caught", () => {
  const { request, claims } = setup(false);
  const comparison = compare(claims, mapping, tables(run));
  const { bundle, hash, files } = buildBundle({ request, task: "t", pkg, run, claims, mapping, comparison, replicator: "r" });
  const edited = { ...files, [FILE]: files[FILE]!.replace("54.26", "54.36") };
  const failed = (b: typeof bundle, h: string, f: typeof files) => verifyBundle({ task: "t", bundle: b, bundleHash: h, manuscript: request.manuscript, files: f }, "v").checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed(bundle, hash, edited).includes("file hashes"));
  assert.ok(failed(bundle, sha256("other"), files).includes("bundle hash"));
  const lying = { ...bundle, comparison: { ...comparison, verdict: "PARTIAL" as const } };
  assert.ok(failed(lying, hash, files).includes("verdict follows from the numbers"));
});
