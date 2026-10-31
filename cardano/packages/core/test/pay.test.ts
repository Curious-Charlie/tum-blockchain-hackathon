/**
 * Tests of the check before signing: a buyer pays only the offer it accepted.
 * The last two run a real x402 seller locally and check that a request that is
 * not the offer is refused before anything is signed (no funds needed).
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { masumiEscrowAddress } from "@x402/cardano";
import { NETWORK, ada, usdm, LOVELACE } from "../config.ts";
import { mismatch, payOffer, PaymentRefused, type Offer } from "../pay.ts";
import { cip20Lines } from "../publish.ts";
import { Seller } from "../seller.ts";
import { Wallet } from "../wallets.ts";

process.env.QUIET_EVENTS = "1";
process.env.DASHBOARD_URL = "http://127.0.0.1:9"; // never reach a real dashboard from tests

const SELLER = "addr_test1qseller";
const offer: Offer = { name: "Keeper", address: SELLER, ...usdm(2) };
const direct = (amount = usdm(2), payTo = SELLER) => ({ payTo, asset: amount.asset, amount: String(amount.amount) });
const escrowLock = (seller = SELLER, payTo = masumiEscrowAddress(NETWORK)) => ({
  ...direct(),
  payTo,
  extra: { assetTransferMethod: "masumi", terms: { sellerAddress: seller } },
});

test("signs the accepted offer, or a lower price", () => {
  assert.equal(mismatch(offer, direct()), undefined);
  assert.equal(mismatch(offer, direct(usdm(1.5))), undefined);
  assert.equal(mismatch(offer, escrowLock()), undefined);
});

test("refuses another payee", () => {
  assert.match(mismatch(offer, direct(usdm(2), "addr_test1qattacker")) ?? "", /not Keeper/);
});

test("refuses a higher price than agreed", () => {
  assert.match(mismatch(offer, direct(usdm(2.000001))) ?? "", /more than the agreed/);
});

test("refuses another asset", () => {
  assert.match(mismatch(offer, direct(ada(2))) ?? "", /another asset/);
  assert.equal(mismatch({ ...offer, ...ada(2) }, direct({ asset: LOVELACE, amount: ada(2).amount })), undefined);
});

test("an escrow lock must go to Masumi's contract, for the agreed seller", () => {
  assert.match(mismatch(offer, escrowLock(SELLER, "addr_test1qnotmasumi")) ?? "", /not Masumi's escrow/);
  assert.match(mismatch(offer, escrowLock("addr_test1qsomeoneelse")) ?? "", /not Keeper/);
});

test("CIP-20 lines are at most 64 bytes and keep characters whole", () => {
  const lines = cip20Lines(["x".repeat(130), "€".repeat(30), "short"]);
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= 64));
  assert.equal(lines.join(""), "x".repeat(130) + "€".repeat(30) + "short");
  assert.equal(lines.at(-1), "short");
});

test("payOffer refuses a real x402 request that is not the offer, before signing", { skip: !process.env.BLOCKFROST_PROJECT_ID && "needs BLOCKFROST_PROJECT_ID" }, async () => {
  process.env.TEST_SELLER_MNEMONIC = generateMnemonic(wordlist, 256);
  process.env.TEST_BUYER_MNEMONIC = generateMnemonic(wordlist, 256);
  const sellerWallet = await Wallet.load("TEST_SELLER", "Test seller");
  const buyerWallet = await Wallet.load("TEST_BUYER", "Test buyer");
  const seller = new Seller(sellerWallet).paid("GET /work", { price: ada(3), description: "test" }, (_req, res) => {
    res.json({ ok: true });
  });
  const { url, close } = await seller.listen(0);
  try {
    // Another payee than the one we agreed with.
    await assert.rejects(payOffer(buyerWallet, { name: "Someone else", address: buyerWallet.address, ...ada(3) }, `${url}/work`), PaymentRefused);
    // More than the agreed price.
    await assert.rejects(payOffer(buyerWallet, { name: sellerWallet.name, address: sellerWallet.address, ...ada(2) }, `${url}/work`), PaymentRefused);
  } finally {
    await close();
  }
});

test("payOffer checks the seller named in Masumi escrow terms", { skip: !process.env.BLOCKFROST_PROJECT_ID && "needs BLOCKFROST_PROJECT_ID" }, async () => {
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

    // The escrow contract is where the money goes, not who it is for: the offer must name the seller.
    await assert.rejects(payOffer(buyerWallet, { name: "Masumi escrow", address: masumiEscrowAddress(NETWORK), ...usdm(5) }, `${url}/job`, post), PaymentRefused);
    await assert.rejects(payOffer(buyerWallet, { name: sellerWallet.name, address: sellerWallet.address, ...usdm(4) }, `${url}/job`, post), PaymentRefused);
  } finally {
    await close();
  }
});
