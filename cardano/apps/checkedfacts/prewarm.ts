/**
 * Runs research and fact-checking WITHOUT payments and prints the check table.
 * Use it before a live demo: it fills the Claude and page caches, so the paid
 * demo afterwards is fast and gives the same result.
 *
 *   npm run prewarm -w apps/checkedfacts [-- --sloppy] [-- --topic "…"]
 */
import { setApp, usageSummary } from "@agentic/core";
import { checkClaim } from "./checker.ts";
import { DEFAULT_TOPIC } from "./config.ts";
import { draftReport, selfCheck, sloppify } from "./researcher.ts";
import { LABEL, gate } from "./verdict.ts";

setApp("checkedfacts-prewarm");
process.env.QUIET_EVENTS ??= "1";
process.env.DASHBOARD_URL ??= "http://127.0.0.1:9"; // keep the shared dashboard clean

const args = process.argv.slice(2);
const sloppy = args.includes("--sloppy");
const topicArg = args.indexOf("--topic");
const topic = topicArg >= 0 && args[topicArg + 1] ? args[topicArg + 1]! : DEFAULT_TOPIC;

const started = Date.now();
const draft = await draftReport(topic, "Research agent");
console.log(`Research: ${draft.claims.length} claims in ${Math.round((Date.now() - started) / 1000)} s\n${draft.summary}\n`);
let claims = draft.claims;
if (sloppy) claims = sloppify(claims);
else {
  const { kept, dropped } = await selfCheck(claims);
  for (const d of dropped) console.log(`self-check dropped: ${d.claim.url} (${d.reason})`);
  claims = kept;
}
const results = await Promise.all(claims.map(checkClaim));
for (const [i, claim] of claims.entries()) {
  const r = results[i]!;
  console.log(`#${claim.id} ${LABEL[r.verdict]}  ${claim.claim}\n     "${claim.quote}"\n     ${claim.url}\n     ${r.reason}`);
}
const verdict = gate(results);
console.log(`\n${verdict.summary} → ${verdict.pass ? "PASS" : "FAIL"}\n${usageSummary()}`);
