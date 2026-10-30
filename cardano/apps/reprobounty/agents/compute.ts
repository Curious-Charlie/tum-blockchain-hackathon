/**
 * Compute agent: sells code runs per call (x402, 1 tUSDM).
 *
 * Runs only allowlisted, hash-pinned packages, each in a fresh temp dir with
 * a timeout and an empty environment (no secrets). A failed run answers 500,
 * so the buyer's signed payment is never submitted.
 * A container sandbox is roadmap; this MVP runs only the package we chose.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Seller, emit, type Wallet } from "@agentic/core";
import { sha256, hashTree, type FileHash } from "../lib/evidence.ts";
import { findPackage, type ReplicationPackage } from "../registry.ts";
import { tusdm } from "../lib/assets.ts";

export const COMPUTE_PRICE = tusdm(1);
const TIMEOUT_MS = 30_000;

export interface RunRequest {
  task: string;
  repo: string;
  commit: string;
  packageSha256: string;
}

export interface RunResult {
  exitCode: number;
  durationMs: number;
  command: string;
  environment: string;
  log: string;
  outputs: (FileHash & { content: string })[];
  package: { sha256: string; files: FileHash[] };
  computeAgent: string;
}

function run(command: string[], cwd: string): Promise<{ exitCode: number; log: string; durationMs: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONHASHSEED: "0", HOME: cwd },
      timeout: TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (chunk) => (log += chunk));
    child.stderr.on("data", (chunk) => (log += chunk));
    child.on("error", (error) => resolve({ exitCode: -1, log: `${log}\n${error.message}`, durationMs: Date.now() - started }));
    child.on("close", (code, signal) => resolve({ exitCode: code ?? (signal ? 124 : -1), log: signal ? `${log}\nkilled: ${signal}` : log, durationMs: Date.now() - started }));
  });
}

/** Copies the package to a fresh temp dir, runs its fixed command without secrets, collects results/. */
export async function executePackage(pkg: ReplicationPackage, computeAgent: string): Promise<RunResult> {
  const tree = hashTree(pkg.dir);
  const dir = mkdtempSync(path.join(os.tmpdir(), "reprobounty-run-"));
  try {
    cpSync(pkg.dir, dir, { recursive: true });
    const result = await run(pkg.command, dir);
    const resultsDir = path.join(dir, "results");
    const outputs = existsSync(resultsDir)
      ? readdirSync(resultsDir).sort().map((name) => {
          const content = readFileSync(path.join(resultsDir, name), "utf8");
          return { path: `results/${name}`, sha256: sha256(content), content };
        })
      : [];
    return {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      command: pkg.command.join(" "),
      environment: result.log.split("\n")[0] ?? "unknown",
      log: result.log,
      outputs,
      package: tree,
      computeAgent,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function startCompute(wallet: Wallet, port: number) {
  const seller = new Seller(wallet).paid("POST /run", { price: COMPUTE_PRICE, description: "Run a pinned replication package in a sandboxed temp dir" }, async (req, res) => {
    const body = req.body as RunRequest;
    const pkg = findPackage(body.repo, body.commit);
    if (!pkg) {
      res.status(404).json({ error: `${body.repo}@${body.commit} is not on the compute allowlist` });
      return;
    }
    const tree = hashTree(pkg.dir);
    if (tree.sha256 !== body.packageSha256) {
      res.status(409).json({ error: "package hash mismatch", expected: body.packageSha256, actual: tree.sha256 });
      return;
    }
    emit({ kind: "task.step", actor: wallet.name, task: body.task, message: `Running \`${pkg.command.join(" ")}\` for ${body.repo.replace("https://github.com/", "")}@${body.commit.slice(0, 7)} in a fresh temp dir (no env vars, ${TIMEOUT_MS / 1000} s timeout)` });
    const result = await executePackage(pkg, wallet.address);
    if (result.exitCode !== 0 || !result.outputs.length) {
      emit({ kind: "task.failed", actor: wallet.name, task: body.task, message: `Run failed (exit ${result.exitCode}); answering 500 so the payment is not taken` });
      res.status(500).json({ error: "run failed", exitCode: result.exitCode, log: result.log });
      return;
    }
    emit({ kind: "task.step", actor: wallet.name, task: body.task, message: `Run finished in ${result.durationMs} ms (exit 0, ${result.environment}); returning ${result.outputs.length} output files and the log` });
    res.json(result);
  });
  return seller.listen(port);
}
