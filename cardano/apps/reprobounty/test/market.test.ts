/**
 * The Replicator's buying decision (lib/market.ts): deterministic, no network.
 *
 *   npm test -w apps/reprobounty
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TUSDM, usdm } from "@agentic/core";
import { chooseProvider, type Quote, type TrackRecord } from "../lib/market.ts";

const quote = (role: string, price: number, overrides: Partial<Quote> = {}): Quote => ({
  role, name: role, url: `http://${role}`, address: `addr_${role}`, payTo: `addr_${role}`, asset: TUSDM, amount: usdm(price).amount, ...overrides,
});
const records: Record<string, TrackRecord> = {
  STANDARD: { runs: 42, verified: 41 },
  BUDGET: { runs: 10, verified: 6 },
  PREMIUM: { runs: 50, verified: 50 },
  NEW: { runs: 2, verified: 2 },
};
const budget = { asset: TUSDM, maxPerPayment: usdm(1.5).amount, availableForCompute: usdm(1.5).amount };

test("picks the cheapest agent within budget with a good record", () => {
  const { chosen, assessments } = chooseProvider([quote("STANDARD", 1), quote("BUDGET", 0.5), quote("PREMIUM", 3)], records, budget);
  assert.equal(chosen?.role, "STANDARD");
  assert.match(assessments.find((a) => a.name === "BUDGET")!.why, /only 60 % of its runs passed verification/);
  assert.match(assessments.find((a) => a.name === "PREMIUM")!.why, /per-payment cap/);
});

test("prefers the cheaper of two good agents, and the better record on a tie", () => {
  assert.equal(chooseProvider([quote("STANDARD", 1), quote("PREMIUM", 0.9)], records, budget).chosen?.role, "PREMIUM");
  assert.equal(chooseProvider([quote("STANDARD", 1), quote("PREMIUM", 1)], records, budget).chosen?.role, "PREMIUM");
});

test("keeps the verifier's fee aside", () => {
  const tight = { ...budget, availableForCompute: usdm(0.8).amount };
  const { chosen, assessments } = chooseProvider([quote("STANDARD", 1)], records, tight);
  assert.equal(chosen, undefined);
  assert.match(assessments[0]!.why, /too little task budget for the Verifier/);
});

test("refuses unproven agents, other assets and quotes that pay someone else", () => {
  const { chosen, assessments } = chooseProvider([
    quote("NEW", 0.1),
    quote("STANDARD", 1, { asset: "lovelace" }),
    quote("PREMIUM", 1, { payTo: "addr_attacker" }),
  ], records, budget);
  assert.equal(chosen, undefined);
  assert.deepEqual(assessments.map((a) => a.why.split(" ")[0]), ["too", "it", "its"]);
});
