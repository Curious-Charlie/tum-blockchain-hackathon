/**
 * Verifier agent: sells a spot-check of an evidence bundle (x402, 1 tUSDM).
 *
 * Fully deterministic. It is paid for doing the check, whatever the outcome
 * (otherwise it would be paid to say "pass"); it answers 4xx only for a
 * request it cannot check at all.
 *
 * Checks: file hashes, bundle hash, manuscript hash, claims are printed in the
 * manuscript, code and data are the pinned package, an independent re-run of
 * the statistics step from the pinned data, and the verdict follows from the
 * numbers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Seller, emit, usdm, type Wallet } from "@agentic/core";
import { compare, validateClaims } from "../lib/compare.ts";
import { bundleHash, hashTree, parseCsv, sha256, type EvidenceBundle } from "../lib/evidence.ts";
import { summarizeTsv, type Summary } from "../lib/stats.ts";
import { findPackage } from "../registry.ts";

export const VERIFIER_PRICE = usdm(1);

export interface VerifyRequest {
  task: string;
  bundle: EvidenceBundle;
  bundleHash: string;
  manuscript: string;
  /** Contents of the bundle's outputs and log, by path. */
  files: Record<string, string>;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  passed: boolean;
  checks: VerifyCheck[];
  bundleHash: string;
  verifier: string;
}

const STATS: (keyof Summary)[] = ["n", "x_mean", "y_mean", "x_sd", "y_sd", "pearson_r"];

export function verifyBundle(request: VerifyRequest, verifierAddress: string): VerifyReport {
  const { bundle, files, manuscript } = request;
  const checks: VerifyCheck[] = [];
  const check = (name: string, run: () => string | true) => {
    try {
      const result = run();
      checks.push({ name, ok: result === true, detail: result === true ? "ok" : result });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  check("bundle hash", () => bundleHash(bundle) === request.bundleHash || "bundle does not hash to the claimed bundle hash");
  check("file hashes", () => {
    const bad = [...bundle.outputs, bundle.log].filter((f) => files[f.path] === undefined || sha256(files[f.path]!) !== f.sha256);
    return bad.length === 0 || `hash mismatch: ${bad.map((f) => f.path).join(", ")}`;
  });
  check("manuscript", () => sha256(manuscript) === bundle.paper.manuscriptSha256 || "manuscript does not match its hash");
  check("claims are printed in the paper", () => {
    const { rejected } = validateClaims(bundle.claims, manuscript);
    return rejected.length === 0 || rejected.map((r) => `${r.claim.id}: ${r.reason}`).join("; ");
  });

  const pkg = findPackage(bundle.code.repo, bundle.code.commit);
  check("pinned code and data", () => {
    if (!pkg) return `${bundle.code.repo}@${bundle.code.commit} is unknown`;
    const tree = hashTree(pkg.dir);
    return tree.sha256 === bundle.code.packageSha256 || `package hash ${bundle.code.packageSha256.slice(0, 12)}… is not ${bundle.code.repo}@${bundle.code.commit.slice(0, 7)} (${tree.sha256.slice(0, 12)}…)`;
  });

  check("re-run: statistics follow from the pinned data", () => {
    if (!pkg) return "no package to re-run";
    const problems: string[] = [];
    let compared = 0;
    for (const step of pkg.rerun) {
      if (files[step.output] === undefined) continue;
      const expected = summarizeTsv(readFileSync(path.join(pkg.dir, step.input), "utf8"));
      const reported = parseCsv(files[step.output]!);
      for (const mine of expected) {
        const row = reported.find((r) => r.dataset === mine.dataset);
        if (!row) {
          problems.push(`${step.output}: dataset ${mine.dataset} missing`);
          continue;
        }
        for (const stat of STATS) {
          const a = Number(row[stat]);
          const b = mine[stat] as number;
          compared++;
          if (!(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)))) problems.push(`${mine.dataset} ${stat}: bundle ${a} vs re-run ${b.toFixed(6)}`);
        }
      }
    }
    if (!compared) return "no output of the statistics step in the bundle";
    return problems.length === 0 || `${problems.length} of ${compared} values do not follow from the data, e.g. ${problems.slice(0, 2).join("; ")}`;
  });

  check("verdict follows from the numbers", () => {
    const tables = Object.fromEntries(bundle.outputs.map((f) => [f.path, parseCsv(files[f.path] ?? "")]));
    const recomputed = compare(bundle.claims, bundle.mapping, tables);
    if (recomputed.verdict !== bundle.comparison.verdict) return `bundle says ${bundle.comparison.verdict}, the numbers say ${recomputed.verdict}`;
    return recomputed.passed === bundle.comparison.passed || `bundle says ${bundle.comparison.passed} checks pass, the numbers say ${recomputed.passed}`;
  });

  return { passed: checks.every((c) => c.ok), checks, bundleHash: request.bundleHash, verifier: verifierAddress };
}

export async function startVerifier(wallet: Wallet, port: number) {
  const seller = new Seller(wallet).paid("POST /verify", { price: VERIFIER_PRICE, description: "Spot-check a reproduction evidence bundle" }, (req, res) => {
    const request = req.body as VerifyRequest;
    if (!request?.bundle || !request.files || typeof request.manuscript !== "string") {
      res.status(400).json({ error: "expected { bundle, bundleHash, manuscript, files }" });
      return;
    }
    emit({ kind: "task.step", actor: wallet.name, task: request.task, message: `Checking evidence bundle ${request.bundleHash.slice(0, 16)}…: hashes, pinned code, and an independent re-run of the statistics step` });
    const report = verifyBundle(request, wallet.address);
    for (const c of report.checks) {
      emit({ kind: "task.step", actor: wallet.name, task: request.task, message: `${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : `: ${c.detail}`}` });
    }
    emit({
      kind: report.passed ? "task.done" : "task.failed",
      actor: wallet.name,
      task: request.task,
      message: report.passed ? "Evidence bundle VERIFIED: all checks pass" : `Evidence bundle REJECTED: ${report.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`,
    });
    // Paid for the check either way: a 200 with passed=false is still a delivered check.
    res.json(report);
  });
  return seller.listen(port);
}
