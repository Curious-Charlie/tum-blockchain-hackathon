/**
 * Masumi escrow pieces that need no chain: the vendored contract, the datum
 * transitions and the deadlines.
 *
 *   npm test -w apps/reprobounty
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Data } from "@evolution-sdk/evolution";
import {
  MASUMI_DEFAULT_DEPLOYMENT, MASUMI_MIN_PAY_TO_SUBMIT_MS, MASUMI_MIN_SUBMIT_RESULT_LEAD_MS, masumiDeadlineIntervalsHold, masumiEscrowScriptHash,
} from "@x402/cardano";
import { ESCROW_DEADLINES } from "@agentic/core";
import { STATE, authorizeRefundDatum, paymentScript, scriptHashHex, submitResultDatum } from "../lib/escrow.ts";

test("the vendored contract is Masumi's escrow", () => {
  assert.equal(scriptHashHex(paymentScript()), masumiEscrowScriptHash(MASUMI_DEFAULT_DEPLOYMENT));
});

// A 19-field datum with distinct placeholder values, enough to see which fields a transition touches.
const lock = Data.constr(0n, Array.from({ length: 19 }, (_, i) => (i === 18 ? Data.constr(STATE.FundsLocked, []) : Data.int(BigInt(1000 + i)))));
const fieldsOf = (d: Data.Data) => (Data.isConstr(d) ? d.fields : []);
const changed = (after: Data.Data) =>
  fieldsOf(after).flatMap((f, i) => (Data.toCBORHex(f) === Data.toCBORHex(fieldsOf(lock)[i]!) ? [] : [i]));

test("SubmitResult changes only the result hash, the cooldowns and the state", () => {
  const after = submitResultDatum(lock, "ab".repeat(32), 123n);
  assert.deepEqual(changed(after), [11, 16, 17, 18]);
  assert.equal(Data.toCBORHex(fieldsOf(after)[18]!), Data.toCBORHex(Data.constr(STATE.ResultSubmitted, [])));
  assert.equal(Data.toCBORHex(fieldsOf(after)[17]!), Data.toCBORHex(Data.int(0n)));
});

test("AuthorizeRefund clears the result hash and moves to RefundAuthorized", () => {
  const after = authorizeRefundDatum(submitResultDatum(lock, "ab".repeat(32), 1n), 456n);
  assert.equal(Data.toCBORHex(fieldsOf(after)[11]!), Data.toCBORHex(Data.bytearray("")));
  assert.equal(Data.toCBORHex(fieldsOf(after)[16]!), Data.toCBORHex(Data.int(456n)));
  assert.equal(Data.toCBORHex(fieldsOf(after)[18]!), Data.toCBORHex(Data.constr(STATE.RefundAuthorized, [])));
  assert.throws(() => authorizeRefundDatum(Data.constr(0n, []), 1n), /Not a vested_pay V2 datum/);
});

test("escrow deadlines satisfy the Masumi rules", () => {
  const quote = BigInt(Date.parse("2026-10-30T15:00:00Z"));
  const payBy = quote + 300_000n; // maxTimeoutSeconds of an escrow route
  const submit = payBy + BigInt(ESCROW_DEADLINES.submitResultAfterPayByMs);
  const unlock = payBy + BigInt(ESCROW_DEADLINES.unlockAfterPayByMs);
  const dispute = payBy + BigInt(ESCROW_DEADLINES.externalDisputeUnlockAfterPayByMs);
  assert.ok(masumiDeadlineIntervalsHold(payBy, submit, unlock, dispute));
  assert.ok(submit - payBy >= MASUMI_MIN_PAY_TO_SUBMIT_MS);
  assert.ok(submit >= quote + MASUMI_MIN_SUBMIT_RESULT_LEAD_MS);
});
