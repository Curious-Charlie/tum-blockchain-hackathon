/**
 * CheckedFacts end to end on Cardano preprod, in one process with three agents
 * talking over HTTP and paying each other with x402:
 *
 *   Shop owner ──3 tUSDM (held)──▶ Research agent ──0.2 tUSDM/claim──▶ Fact-checker agent
 *
 * The shop owner's payment settles only if the report passes the fact-check.
 *
 *   npm run demo -w apps/checkedfacts                 # honest researcher: report passes, 3 tUSDM settle
 *   npm run demo -w apps/checkedfacts -- --sloppy     # sloppy researcher: report fails, shop owner pays nothing
 *   npm run demo -w apps/checkedfacts -- --topic "…"  # another topic (first run takes a few minutes, then cached)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Agent, setGlobalDispatcher } from "undici";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { AgentGuard, EXPLORER_TX, ROOT, Wallet, emit, flushEvents, formatAmount, limits, setApp, usageSummary } from "@agentic/core";
import { startChecker } from "./checker.ts";
import { CHECKER_PORT, DEFAULT_TOPIC, REPORT_PRICE, RESEARCHER_PORT, tusdm } from "./config.ts";
import { startResearcher, type ReportBody } from "./researcher.ts";
import { LABEL } from "./verdict.ts";
import { waitUntilIdle } from "./chain.ts";

setApp("checkedfacts");
// A fresh (uncached) research run can take a few minutes; Node's default 300 s header timeout is too tight.
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));

const args = process.argv.slice(2);
const sloppy = args.includes("--sloppy");
const topicArg = args.indexOf("--topic");
const topic = topicArg >= 0 && args[topicArg + 1] ? args[topicArg + 1]! : DEFAULT_TOPIC;
const task = `${sloppy ? "sloppy" : "report"}-${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`;
const price = formatAmount(REPORT_PRICE.asset, REPORT_PRICE.amount);

const customer = (await Wallet.load("CUSTOMER", "Shop owner")).online(`buys a fact-checked competitor report for ${price}`);
const researcher = (await Wallet.load("RESEARCHER", "Research agent")).online(`Claude Sonnet + web search; sells reports, pays for fact-checks${sloppy ? " (sloppy today)" : ""}`);
const checker = (await Wallet.load("CHECKER", "Fact-checker agent")).online("fetches every source, matches quotes in code, Claude Haiku judges support; 0.2 tUSDM per claim");

// A transaction from a previous run may still be in the mempool; spending now would reuse its inputs.
await Promise.all([waitUntilIdle(customer), waitUntilIdle(researcher)]);

const checkerService = await startChecker(checker, CHECKER_PORT);
const researcherService = await startResearcher({
  wallet: researcher,
  checker: { name: checker.name, address: checker.address, url: checkerService.url },
  port: RESEARCHER_PORT,
  sloppy,
});

const guard = new AgentGuard(customer, {
  maxPerPayment: limits(tusdm(5)),
  maxPerTask: limits(tusdm(5)),
  maxPerDay: limits(tusdm(60)),
  payees: { [researcher.address]: researcher.name },
});

const line = "─".repeat(78);
try {
  emit({ kind: "task.started", actor: customer.name, task, message: `Orders "${topic}" for ${price}, payable only if an independent fact-check passes` });
  const response = await guard.fetch(
    `${researcherService.url}/report`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, task }) },
    { task, purpose: "a fact-checked research report" },
  );
  const body = (await response.json()) as Partial<ReportBody> & { error?: string };
  const header = response.headers.get("PAYMENT-RESPONSE");
  const paidTx = response.ok && header ? decodePaymentResponseHeader(header).transaction : undefined;

  console.log(`\n${line}\n${response.ok ? "REPORT DELIVERED" : `NO REPORT (HTTP ${response.status})`}: ${topic}\n${line}`);
  if (body.summary) console.log(`\n${body.summary}\n`);
  const checks = new Map((body.checks ?? []).map((c) => [c.id, c]));
  for (const claim of body.claims ?? []) {
    const check = checks.get(claim.id);
    console.log(`#${claim.id} ${check ? LABEL[check.verdict] : "unchecked"}  ${claim.claim}`);
    console.log(`     "${claim.quote}"\n     ${claim.url}${check && check.verdict !== "supported" ? `\n     checker: ${check.reason}` : ""}`);
  }
  if (body.verdict) console.log(`\nFact-check: ${body.verdict.summary} → ${body.verdict.pass ? "PASS" : "FAIL"}`);
  for (const tx of body.checkPayments ?? []) console.log(`Research agent paid the fact-checker: ${EXPLORER_TX}${tx}`);
  if (paidTx) console.log(`Shop owner paid ${price} for the report:   ${EXPLORER_TX}${paidTx}`);
  else console.log(`Shop owner paid nothing: ${body.error ?? "the payment was voided"}`);

  emit({
    kind: response.ok ? "task.done" : "task.failed",
    actor: customer.name,
    task,
    tx: paidTx,
    message: response.ok
      ? `Received the report (${body.verdict?.summary}) and paid ${price}`
      : `No report and no charge: ${body.error ?? `HTTP ${response.status}`}`,
  });

  const out = path.join(ROOT, ".cache", "checkedfacts", `${task}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ topic, status: response.status, paidTx, ...body }, null, 2));
  console.log(`\nSaved ${path.relative(process.cwd(), out)}\n${usageSummary()}\n${line}`);
} finally {
  await researcherService.close();
  await checkerService.close();
  await flushEvents();
}
