/**
 * D5 ReproBounty end to end on Cardano preprod, one command:
 *
 *   npm run demo -w apps/reprobounty                 # real paper → REPRODUCED, paid, certificate on chain
 *   npm run demo -w apps/reprobounty -- --altered    # one number changed → NOT REPRODUCED, still paid and published
 *   npm run demo -w apps/reprobounty -- --tamper     # fabricated evidence → verifier rejects → requester pays nothing
 *
 * Add --escrow to pay the bounty through Masumi escrow instead of x402 pay-on-success:
 * the journal locks 5 tUSDM first, the Replicator works, then puts the result hash
 * into the escrow (collected later: npm run escrow -w apps/reprobounty) or, with
 * --tamper, authorizes a refund that the journal withdraws at once. --escrow --vanish:
 * the Replicator takes the job and disappears; the journal refunds after the deadline.
 *
 * Four agents with their own wallets: Requester (journal) → Replicator →
 * Compute and Verifier. Events stream to the dashboard (npm run dashboard).
 */
import {
  AgentGuard, ESCROW, EXPLORER_TX, LOVELACE, TUSDM, Wallet, balanceOf, emit, flushEvents, formatAmount, limits,
  setApp, sleep, usageSummary, usdm, waitForTx,
} from "@agentic/core";
import { startCompute } from "./agents/compute.ts";
import { startReplicator, type ReproRequest, type ReproResponse } from "./agents/replicator.ts";
import { startVerifier, type VerifyReport } from "./agents/verifier.ts";
import { settlementTx } from "./lib/chain.ts";
import { escrowOutputOf, record, withdrawRefund, type EscrowJob } from "./lib/escrow.ts";
import { DEMO_TARGET, PACKAGES, demoPaper } from "./registry.ts";

setApp("reprobounty");
const args = process.argv.slice(2);
const altered = args.includes("--altered");
const tamper = args.includes("--tamper");
const noWait = args.includes("--no-wait");
const escrow = args.includes("--escrow");
const vanish = escrow && args.includes("--vanish");
const PORT = Number(process.env.REPROBOUNTY_PORT ?? 4151);

const [requester, replicator, computeWallet, verifierWallet, budgetWallet, premiumWallet] = await Promise.all([
  Wallet.load("REQUESTER", "Requester (journal)"),
  Wallet.load("REPLICATOR", "Replicator agent"),
  Wallet.load("COMPUTE", "Compute agent"),
  Wallet.load("VERIFIER", "Verifier agent"),
  Wallet.load("COMPUTE_B", "Budget compute agent"),
  Wallet.load("COMPUTE_C", "Premium compute agent"),
]);

// Three compute agents sell the same runs at different prices; the Replicator chooses (lib/market.ts).
const compute = await startCompute(computeWallet.online("sells sandboxed code runs, 1 tUSDM per run"), PORT + 1);
const budgetCompute = await startCompute(budgetWallet.online("sells sandboxed code runs, 0.5 tUSDM per run"), PORT + 3, usdm(0.5));
const premiumCompute = await startCompute(premiumWallet.online("sells sandboxed code runs, 3 tUSDM per run"), PORT + 4, usdm(3));
const verifier = await startVerifier(verifierWallet.online("spot-checks evidence bundles, 1 tUSDM per check"), PORT + 2);
const replicatorServer = await startReplicator({
  wallet: replicator.online(`sells verified reproductions, 5 tUSDM${tamper ? " (DEMO: dishonest mode)" : ""}`),
  port: PORT,
  computes: [
    { role: "COMPUTE", url: compute.url, name: computeWallet.name, address: computeWallet.address },
    { role: "COMPUTE_B", url: budgetCompute.url, name: budgetWallet.name, address: budgetWallet.address },
    { role: "COMPUTE_C", url: premiumCompute.url, name: premiumWallet.name, address: premiumWallet.address },
  ],
  verifier: { url: verifier.url, name: verifierWallet.name, address: verifierWallet.address },
  tamper,
  vanish,
});
requester.online("journal: posts reproduction bounties, pays through AgentGuard");

const guard = new AgentGuard(requester, {
  maxPerPayment: limits(usdm(5)),
  maxPerTask: limits(usdm(5)),
  maxPerDay: limits(usdm(60)),
  payees: { [replicator.address]: replicator.name },
});

const paper = demoPaper(altered);
const pkg = PACKAGES[0]!;
const task = `repro-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}${altered ? "-altered" : ""}${tamper ? "-tamper" : ""}${escrow ? "-escrow" : ""}${vanish ? "-vanish" : ""}`;
const request: ReproRequest = {
  task,
  paper: { doi: paper.doi, title: paper.title },
  manuscript: paper.manuscript,
  code: { repo: pkg.repo, commit: pkg.commit },
  target: DEMO_TARGET,
};

console.log(`\n=== ReproBounty: ${paper.title}${tamper ? " · DEMO: tampered evidence" : ""}${escrow ? " · Masumi escrow" : ""} ===\n`);
emit({
  kind: "task.started",
  actor: requester.name,
  task,
  message: `Bounty: reproduce "${DEMO_TARGET}" of ${paper.title} (doi:${paper.doi}). Pays 5 tUSDM for a verified attempt, whatever the verdict${escrow ? ", locked in Masumi escrow first" : ""}`,
});

const started = Date.now();
let exitCode = 0;

/** --escrow: lock the bounty in Masumi escrow, then follow the job until it is delivered or refunded. */
async function escrowRun(): Promise<number> {
  const jobUrl = (id: string) => `${replicatorServer.url}/jobs/${id}`;
  const response = await guard.fetch(`${replicatorServer.url}/reproduce/escrow`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) },
    { task, purpose: "a verified reproduction (escrow)" },
  );
  if (response.status !== 202) {
    console.log(`\nReplicator answered HTTP ${response.status}: no lock was made`);
    return 1;
  }
  const { jobId } = (await response.json()) as { jobId: string };
  const lockTx = settlementTx(response.headers.get("PAYMENT-RESPONSE"));
  console.log(`\nJob ${jobId}: 5 tUSDM locked in Masumi escrow${lockTx ? `\n  ${EXPLORER_TX}${lockTx}` : ""}`);

  // Follow the job (local HTTP, no chain calls) until the Replicator delivers, refunds or vanishes.
  const deadline = Date.now() + 15 * 60_000;
  let job: EscrowJob | undefined;
  while (Date.now() < deadline) {
    job = (await (await fetch(jobUrl(jobId))).json()) as EscrowJob;
    const delivered = job.status === "result_submitted" && job.certificateTx;
    if (delivered || job.status === "vanished" || job.status === "refund_authorized" || job.status === "failed") break;
    await sleep(5_000);
  }
  if (!job) return 1;
  const at = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString() : "?");

  if (job.status === "result_submitted") {
    console.log(`\nVerified ${job.verdict}: the result hash is in the escrow. The Replicator collects from ${at(job.unlockTime)}:`);
    console.log("  npm run escrow -w apps/reprobounty -- finish --wait");
    if (job.certificateTx) console.log(`Certificate: ${EXPLORER_TX}${job.certificateTx}`);
    emit({ kind: "task.done", actor: requester.name, task, message: `Received a verified ${job.verdict}; the 5 tUSDM stay in escrow until ${at(job.unlockTime)} (the journal's dispute window), then go to the Replicator` });
    if (job.certificateTx && !noWait) await waitForTx(job.certificateTx);
    return 0;
  }
  if (job.status === "refund_authorized") {
    console.log(`\nReplicator could not deliver (${job.error}). It authorized a refund; withdrawing the 5 tUSDM now…`);
    const escrowUtxo = await escrowOutputOf(requester, job.escrowTx!);
    if (!escrowUtxo) throw new Error("refund authorized, but no escrow output found");
    const tx = await withdrawRefund(requester, escrowUtxo);
    job.status = "refunded";
    record(job, "withdraw_refund", tx);
    emit({ kind: "payment.settled", actor: requester.name, task, from: ESCROW, to: requester.name, amount: "5 tUSDM", tx, message: `${requester.name} took its 5 tUSDM back from the escrow: the work failed verification, so the journal pays nothing` });
    console.log(`Refund: ${EXPLORER_TX}${tx}`);
    return tamper ? 0 : 1;
  }
  if (job.status === "vanished") {
    console.log(`\nThe Replicator vanished. The journal can take its 5 tUSDM back from ${at(job.submitResultTime)}:`);
    console.log("  npm run escrow -w apps/reprobounty -- finish --wait");
    emit({ kind: "task.step", actor: requester.name, task, message: `No result reached the escrow. Refundable from ${at(job.submitResultTime)} (the submit-result deadline)` });
    return 0;
  }
  console.log(`\nJob ended as ${job.status}${job.error ? `: ${job.error}` : ""}`);
  return 1;
}

/** x402 pay-on-success: the signed 5 tUSDM is submitted only if the Replicator answers 200. */
async function x402Run(): Promise<number> {
  const response = await guard.fetch(`${replicatorServer.url}/reproduce`,
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
      console.log("No certificate was published.");
      return 1;
    }
  } else {
    const body = (await response.json().catch(() => ({}))) as { error?: string; verification?: VerifyReport };
    console.log(`\nReplicator answered HTTP ${response.status}: ${body.error ?? "error"} (${seconds} s)`);
    for (const c of body.verification?.checks ?? []) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`);
    emit({ kind: "task.failed", actor: requester.name, task, message: `Replicator answered HTTP ${response.status} (${body.error ?? "error"}): the signed 5 tUSDM was never submitted, the journal pays nothing` });
    if (!tamper) return 1;
  }
  return 0;
}

try {
  exitCode = escrow ? await escrowRun() : await x402Run();
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
  await Promise.all([replicatorServer.close(), compute.close(), budgetCompute.close(), premiumCompute.close(), verifier.close()]);
  await flushEvents();
}
process.exit(exitCode);
