/**
 * Tests for the deterministic parts of CheckedFacts: quote matching, the
 * money gate and sloppy mode. No network, no Claude.
 *
 *   npm test -w apps/checkedfacts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { findQuote, htmlToText, normalize } from "../pages.ts";
import { sloppify } from "../researcher.ts";
import { gate, type CheckResult, type CheckVerdict } from "../verdict.ts";

const PAGE = htmlToText(`<html><head><title>Coffee in Munich</title><meta name="description" content="A guide."></head>
<body><nav>Home</nav><p>Man versus Machine opened its first caf&eacute; in 2014 on M&uuml;llerstra&szlig;e and roasts on site.</p>
<script>var x = "ignore me";</script><p>A flat white costs &euro;4.20 at most &#8220;third wave&#8221; shops.</p></body></html>`).text;

test("htmlToText keeps visible text, decodes entities, drops scripts", () => {
  assert.match(PAGE, /Müllerstraße/);
  assert.match(PAGE, /€4\.20/);
  assert.doesNotMatch(PAGE, /ignore me/);
});

test("normalize ignores case, punctuation and typographic quotes", () => {
  assert.equal(normalize("“Third-Wave” Shops!"), normalize('"third wave" shops'));
});

test("findQuote matches verbatim quotes despite punctuation and case", () => {
  assert.equal(findQuote("Man versus Machine opened its first café in 2014 on Müllerstraße", PAGE).found, true);
  assert.equal(findQuote("a flat white costs €4.20 at most “third wave” shops", PAGE).found, true);
});

test("findQuote rejects altered numbers, invented words and short quotes", () => {
  assert.equal(findQuote("Man versus Machine opened its first café in 2016 on Müllerstraße", PAGE).found, false);
  assert.equal(findQuote("Man versus Machine opened its biggest café in 2014 on Müllerstraße", PAGE).found, false);
  assert.equal(findQuote("roasts on site", PAGE).found, false);
});

test("findQuote does not match inside words", () => {
  assert.equal(findQuote("an versus Machine opened its first café", PAGE).found, false);
});

test("findQuote accepts ellipses only when every part is on the page in order", () => {
  assert.equal(findQuote("Man versus Machine opened its first café … roasts on site and", PAGE).found, false);
  assert.equal(findQuote("Man versus Machine opened its first … in 2014 on Müllerstraße and roasts", PAGE).found, true);
  assert.equal(findQuote("in 2014 on Müllerstraße and roasts … Man versus Machine opened its", PAGE).found, false);
});

const results = (...verdicts: CheckVerdict[]): CheckResult[] => verdicts.map((verdict, i) => ({ id: i + 1, verdict, reason: "" }));

test("gate passes 8/8 and 7/8, fails 6/8", () => {
  assert.equal(gate(results(...Array<CheckVerdict>(8).fill("supported"))).pass, true);
  assert.equal(gate(results(...Array<CheckVerdict>(7).fill("supported"), "unsupported")).pass, true);
  assert.equal(gate(results(...Array<CheckVerdict>(6).fill("supported"), "unsupported", "quote_not_found")).pass, false);
});

test("gate: unverifiable claims are excluded, but at least 5 must be checkable", () => {
  const some = gate(results("supported", "supported", "supported", "supported", "supported", "unverifiable", "unverifiable"));
  assert.equal(some.pass, true);
  assert.equal(some.checkable, 5);
  const most = gate(results("supported", "supported", "supported", "supported", "unverifiable", "unverifiable", "unverifiable"));
  assert.equal(most.pass, false);
});

test("sloppify breaks claims 1-4 and leaves the rest", () => {
  const claims = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, claim: `Claim ${i}.`, url: `https://example.com/${i % 3}`, quote: `quote number ${i} with enough words in it` }));
  const sloppy = sloppify(claims);
  assert.notEqual(sloppy[0]!.quote, claims[0]!.quote);
  assert.notEqual(sloppy[1]!.url, claims[1]!.url);
  assert.notEqual(sloppy[2]!.claim, claims[2]!.claim);
  assert.notEqual(sloppy[3]!.quote, claims[3]!.quote);
  assert.deepEqual(sloppy.slice(4), claims.slice(4));
});

test("certificate lines fit CIP-20 (64 bytes each) and carry the verdict", async () => {
  const { certificateLines } = await import("../checker.ts");
  const claims = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, claim: `Claim ${i}.`, url: "https://example.com", quote: "q" }));
  const lines = certificateLines("report-123456", claims, results("supported", "supported", "unsupported", "quote_not_found", "unverifiable", "supported", "supported", "supported"));
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 64, line);
  assert.ok(lines.some((l) => l === "per claim SSUQ?SSS"));
  assert.ok(lines.some((l) => l.startsWith("verdict FAIL: 5/7")));
});
