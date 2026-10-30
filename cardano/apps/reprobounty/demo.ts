/**
 * D5 ReproBounty end to end on Cardano preprod, one command:
 *
 *   npm run demo -w apps/reprobounty                 # real paper → REPRODUCED, paid, certificate on chain
 *   npm run demo -w apps/reprobounty -- --altered    # one number changed → NOT REPRODUCED, still paid and published
 *   npm run demo -w apps/reprobounty -- --tamper     # fabricated evidence → verifier rejects → requester pays nothing
 *
 * Four agents with their own wallets: Requester (journal) → Replicator →
 * Compute and Verifier. Events stream to the dashboard (npm run dashboard).
 */
import {
  AgentGuard, EXPLORER_TX, LOVELACE, TUSDM, Wallet, balanceOf, emit, flushEvents, formatAmount, limits,
  setApp, usageSummary, waitForTx,
} from "@agentic/core";
import { startCompute } from "./agents/compute.ts";
import { startReplicator, type ReproRequest, type ReproResponse } from "./agents/replicator.ts";
import { startVerifier, type VerifyReport } from "./agents/verifier.ts";
import { tusdm } from "./lib/assets.ts";
import { rememberLastTx, settlementTx } from "./lib/chain.ts";
import { DEMO_TARGET, PACKAGES, demoPaper } from "./registry.ts";

setApp("reprobounty");
const args = process.argv.slice(2);
const altered = args.includes("--altered");
const tamper = args.includes("--tamper");
const noWait = args.includes("--no-wait");
const PORT = Number(process.env.REPROBOUNTY_PORT ?? 4151);

const [requester, replicator, computeWallet, verifierWallet] = await Promise.all([
  Wallet.load("REQUESTER", "Requester (journal)"),
  Wallet.load("REPLICATOR", "Replicator agent"),
  Wallet.load("COMPUTE", "Compute agent"),
  Wallet.load("VERIFIER", "Verifier agent"),
]);
rememberLastTx([requester, replicator]);

const compute = await startCompute(computeWallet.online("sells sandboxed code runs, 1 tUSDM per run"), PORT + 1);
const verifier = await startVerifier(verifierWallet.online("spot-checks evidence bundles, 1 tUSDM per check"), PORT + 2);
const replicatorServer = await startReplicator({
  wallet: replicator.online(`sells verified reproductions, 5 tUSDM${tamper ? " (DEMO: dishonest mode)" : ""}`),
  port: PORT,
  compute: { url: compute.url, name: computeWallet.name, address: computeWallet.address },
  verifier: { url: verifier.url, name: verifierWallet.name, address: verifierWallet.address },
  tamper,
});
requester.online("journal: posts reproduction bounties, pays through AgentGuard");

const guard = new AgentGuard(requester, {
  maxPerPayment: limits(tusdm(5)),
  maxPerTask: limits(tusdm(5)),
  maxPerDay: limits(tusdm(60)),
  payees: { [replicator.address]: replicator.name },
});

const paper = demoPaper(altered);
const pkg = PACKAGES[0]!;
const task = `repro-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}${altered ? "-altered" : ""}${tamper ? "-tamper" : ""}`;
const request: ReproRequest = {
  task,
  paper: { doi: paper.doi, title: paper.title },
  manuscript: paper.manuscript,
  code: { repo: pkg.repo, commit: pkg.commit },
  target: DEMO_TARGET,
};

console.log(`\n=== ReproBounty: ${paper.title}${tamper ? " · DEMO: tampered evidence" : ""} ===\n`);
emit({
  kind: "task.started",
  actor: requester.name,
  task,
  message: `Bounty: reproduce "${DEMO_TARGET}" of ${paper.title} (doi:${paper.doi}). Pays 5 tUSDM for a verified attempt, whatever the verdict`,
});

const started = Date.now();
let exitCode = 0;
try {
  const response = await guard.fetch(
    `${replicatorServer.url}/reproduce`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) },
    { task, purpose: "a verified reproduction" },
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  if (response.ok) {
    const result = (await response.json()) as ReproResponse;
    const paidTx = settlementTx(response.headers.get("PAYMENT-RESPONSE"));
    console.log(`\nVerdict: ${result.verdict}  (${result.passed}/${result.total} checks, ${seconds} s)`);
    console.table(result.claims.map((c) => ({ claim: c.symbol, paper: c.claimed, "datasets matching": `${c.matched}/${c.total}`, "computed range": `${c.range[0].toFixed(4)} … ${c.range[1].toFixed(4)}` })));
    console.log(`Conventions: ${result.conventions.truncation}/${result.total} match when truncated, ${result.conventions.rounding}/${result.total} when rounded`);
    console.log(`Evidence bundle ${result.bundleHash}\n  ${result.evidenceFile}`);
    emit({ kind: "task.done", actor: requester.name, task, message: `Received a verified ${result.verdict} after ${seconds} s; paid 5 tUSDM` });
    if (paidTx) console.log(`Bounty payment: ${EXPLORER_TX}${paidTx}`);

    const certificate = await replicatorServer.certificate(task);
    if (certificate) {
      console.log(`\nCertificate (CIP-20 metadata, label 674): ${certificate.url}\n${certificate.lines.map((l) => `  | ${l}`).join("\n")}`);
      if (!noWait) {
        emit({ kind: "task.step", actor: replicator.name, task, message: "Waiting for the certificate to be included in a block…" });
        await waitForTx(certificate.tx);
        emit({ kind: "task.done", actor: replicator.name, task, message: "Certificate is on Cardano preprod: anyone can read it in the transaction metadata", tx: certificate.tx });
      }
    } else {
      exitCode = 1;
      console.log("No certificate was published.");
    }
  } else {
    const body = (await response.json().catch(() => ({}))) as { error?: string; verification?: VerifyReport };
    console.log(`\nReplicator answered HTTP ${response.status}: ${body.error ?? "error"} (${seconds} s)`);
    for (const c of body.verification?.checks ?? []) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`);
    emit({ kind: "task.failed", actor: requester.name, task, message: `Replicator answered HTTP ${response.status} (${body.error ?? "error"}): the signed 5 tUSDM was never submitted, the journal pays nothing` });
    if (!tamper) exitCode = 1;
  }
} catch (error) {
  exitCode = 1;
  console.error(error);
  emit({ kind: "task.failed", actor: requester.name, task, message: `Request failed: ${error instanceof Error ? error.message : String(error)}` });
} finally {
  console.log(`\n${usageSummary()}`);
  const wallets = [requester, replicator, computeWallet, verifierWallet];
  const balances = await Promise.all(wallets.map((w) => balanceOf(w.address).catch(() => undefined)));
  console.log("Balances (confirmed):");
  for (const [i, w] of wallets.entries()) {
    const b = balances[i];
    console.log(`  ${w.name.padEnd(20)} ${b ? `${formatAmount(LOVELACE, b[LOVELACE] ?? 0n)}, ${formatAmount(TUSDM, b[TUSDM] ?? 0n)}` : "?"}`);
  }
  await Promise.all([replicatorServer.close(), compute.close(), verifier.close()]);
  await flushEvents();
}
process.exit(exitCode);
