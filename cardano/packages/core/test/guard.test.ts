/**
 * AgentGuard policy tests. The last test runs a real x402 seller locally and
 * checks that a refused payment is blocked before anything is signed (no chain
 * access, no funds needed).
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ada, usdm, TUSDM, LOVELACE } from "../config.ts";
import { checkPayment, limits, payees, AgentGuard, PaymentBlocked, unfreezeAll, freezeAll, type GuardPolicy, type SpendState } from "../guard.ts";
import { cip20Lines } from "../publish.ts";
import { Seller } from "../seller.ts";
import { Wallet } from "../wallets.ts";

process.env.QUIET_EVENTS = "1";
process.env.DASHBOARD_URL = "http://127.0.0.1:9"; // never reach a real dashboard from tests

const SELLER = "addr_test1qseller";
const policy: GuardPolicy = {
  maxPerPayment: limits(ada(5), usdm(10)),
  maxPerTask: limits(ada(8), usdm(20)),
  maxPerDay: limits(ada(20), usdm(50)),
  payees: { [SELLER]: "Compute agent" },
};
const fresh = (): SpendState => ({ spentToday: {}, spentOnTask: {} });
const pay = (amount: { asset: string; amount: bigint }, payTo = SELLER) => ({ payTo, ...amount });

test("allows a payment within every limit", () => {
  assert.deepEqual(checkPayment(policy, fresh(), pay(ada(5))), { ok: true });
  assert.deepEqual(checkPayment(policy, fresh(), pay(usdm(2.5))), { ok: true });
});

test("refuses a payee that is not on the allowlist", () => {
  const verdict = checkPayment(policy, fresh(), pay(ada(1), "addr_test1qattacker"));
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.rule, "payee");
});

test("refuses a payment over the per-payment cap", () => {
  const verdict = checkPayment(policy, fresh(), pay(ada(5.000001)));
  assert.equal(!verdict.ok && verdict.rule, "per_payment");
});

test("refuses a payment that would exceed the task budget", () => {
  const state = { ...fresh(), spentOnTask: { [LOVELACE]: ada(4).amount } };
  assert.equal(checkPayment(policy, state, pay(ada(4))).ok, true);
  const verdict = checkPayment(policy, state, pay(ada(4.5)));
  assert.equal(!verdict.ok && verdict.rule, "per_task");
});

test("refuses a payment that would exceed the daily budget", () => {
  const state = { ...fresh(), spentToday: { [TUSDM]: usdm(45).amount } };
  const verdict = checkPayment(policy, state, pay(usdm(6)));
  assert.equal(!verdict.ok && verdict.rule, "per_day");
});

test("refuses an asset without a cap (fail closed)", () => {
  const verdict = checkPayment(policy, fresh(), pay({ asset: "ab".repeat(28) + "00", amount: 1n }));
  assert.equal(!verdict.ok && verdict.rule, "asset");
});

test("refuses everything while frozen", () => {
  const verdict = checkPayment(policy, { ...fresh(), frozen: "operator" }, pay(ada(1)));
  assert.equal(!verdict.ok && verdict.rule, "frozen");
});

test("CIP-20 lines are at most 64 bytes and keep characters whole", () => {
  const lines = cip20Lines(["x".repeat(130), "€".repeat(30), "short"]);
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= 64));
  assert.equal(lines.join(""), "x".repeat(130) + "€".repeat(30) + "short");
  assert.equal(lines.at(-1), "short");
});

test("guard.fetch blocks a real x402 request before signing", { skip: !process.env.BLOCKFROST_PROJECT_ID && "needs BLOCKFROST_PROJECT_ID" }, async () => {
  process.env.TEST_SELLER_MNEMONIC = generateMnemonic(wordlist, 256);
  process.env.TEST_BUYER_MNEMONIC = generateMnemonic(wordlist, 256);
  const sellerWallet = await Wallet.load("TEST_SELLER", "Test seller");
  const buyerWallet = await Wallet.load("TEST_BUYER", "Test buyer");
  const seller = new Seller(sellerWallet).paid("GET /work", { price: ada(3), description: "test" }, (_req, res) => {
    res.json({ ok: true });
  });
  const { url, close } = await seller.listen(0);
  try {
    // Payee not on the allowlist.
    const stranger = new AgentGuard(buyerWallet, { ...policy, payees: {} });
    await assert.rejects(stranger.fetch(`${url}/work`), (error: unknown) => error instanceof PaymentBlocked && error.rule === "payee");

    // Over the per-payment cap.
    const tight = new AgentGuard(buyerWallet, { ...policy, maxPerPayment: limits(ada(2)), payees: { [sellerWallet.address]: "Test seller" } });
    await assert.rejects(tight.fetch(`${url}/work`), (error: unknown) => error instanceof PaymentBlocked && error.rule === "per_payment");

    // Machine-wide kill switch.
    freezeAll("test");
    const frozen = new AgentGuard(buyerWallet, { ...policy, payees: { [sellerWallet.address]: "Test seller" } });
    await assert.rejects(frozen.fetch(`${url}/work`), (error: unknown) => error instanceof PaymentBlocked && error.rule === "frozen");
  } finally {
    unfreezeAll();
    await close();
  }
});

test("guard.fetch checks the seller named in Masumi escrow terms", { skip: !process.env.BLOCKFROST_PROJECT_ID && "needs BLOCKFROST_PROJECT_ID" }, async () => {
  process.env.ESCROW_SELLER_MNEMONIC = generateMnemonic(wordlist, 256);
  process.env.ESCROW_BUYER_MNEMONIC = generateMnemonic(wordlist, 256);
  const sellerWallet = await Wallet.load("ESCROW_SELLER", "Escrow seller");
  const buyerWallet = await Wallet.load("ESCROW_BUYER", "Escrow buyer");
  const seller = new Seller(sellerWallet).paid("POST /job", { price: usdm(5), description: "test", escrow: true }, (_req, res) => {
    res.status(202).json({ ok: true });
  });
  const { url, close } = await seller.listen(0);
  const post = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job: 1 }) };
  try {
    const quote = await fetch(`${url}/job`, post);
    assert.equal(quote.status, 402);

    // The escrow contract is not the payee: the allowlist must name the seller.
    const escrowOnly = new AgentGuard(buyerWallet, { ...policy, payees: {} });
    await assert.rejects(escrowOnly.fetch(`${url}/job`, post), (error: unknown) => error instanceof PaymentBlocked && error.rule === "payee");

    const tight = new AgentGuard(buyerWallet, { ...policy, maxPerPayment: limits(usdm(4)), payees: payees(sellerWallet) });
    await assert.rejects(tight.fetch(`${url}/job`, post), (error: unknown) => error instanceof PaymentBlocked && error.rule === "per_payment");
  } finally {
    await close();
  }
});
