/**
 * Masumi escrow (`vested_pay`, payment V2): pay first into escrow, settle after
 * delivery. x402 makes the lock (a `Seller` route with `escrow: true`); this
 * file checks the lock and builds the transactions after it with evolution-sdk.
 * Blockfrost evaluates the scripts during build(), so a rule violation throws
 * before anything is signed.
 *
 *   seller  submitResult     FundsLocked → ResultSubmitted: the result hash goes on chain
 *           collect          Withdraw from unlock_time: bounty to the seller, deposit back to the buyer
 *           authorizeRefund  FundsLocked → RefundAuthorized: the work failed, the seller gives the money back
 *   buyer   withdrawRefund   at once after authorizeRefund; from submit_result_time if the seller never delivered
 *
 * Seller-side builders follow reference/x402-cardano-demo/masumi/src/chain.ts;
 * the refund actions follow the validator source (vested_pay.ak, AuthorizeRefund
 * and WithdrawRefund branches). Jobs are recorded per app in
 * cardano/.cache/escrow/<app>/ so the deadline-bound steps can run later.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Address, Assets, CBOR, Data, InlineDatum, KeyHash, PlutusV3, ScriptHash, SlotConfig, Time, TransactionHash, TransactionInput, UPLC, type UTxO } from "@evolution-sdk/evolution";
import { MASUMI_DEFAULT_DEPLOYMENT, addressCredentials, masumiEscrowAddress, parseMasumiLockDatum, type MasumiDatumView } from "@x402/cardano";
import { NETWORK, ROOT, blockfrost, formatAmount, toUnit, waitForTx, type Amount } from "./config.ts";
import { appName } from "./events.ts";
import type { Settled } from "./seller.ts";
import type { Wallet } from "./wallets.ts";

export const ESCROW_ADDRESS = masumiEscrowAddress(NETWORK);

/** vested_pay states (datum field 18). */
export const STATE = { FundsLocked: 0n, ResultSubmitted: 1n, RefundRequested: 2n, Disputed: 3n, WithdrawAuthorized: 4n, RefundAuthorized: 5n } as const;

/** vested_pay redeemers: the constructor index of the action. */
const REDEEMER = {
  withdraw: Data.constr(0n, []),
  setRefundRequested: Data.constr(1n, []),
  withdrawRefund: Data.constr(3n, []),
  submitResult: Data.constr(5n, []),
  authorizeRefund: Data.constr(6n, []),
};

// ---------------------------------------------------------------- script and time

const blueprint = () =>
  (JSON.parse(readFileSync(new URL("./contracts/payment-v2.plutus.json", import.meta.url), "utf8")) as { validators: { compiledCode: string }[] }).validators[0]!.compiledCode;

/** `vested_pay(required_admins, admin_vks, cooldown_period)` with Masumi's preprod parameters. */
export function paymentScript(): PlutusV3.PlutusV3 {
  const deployment = MASUMI_DEFAULT_DEPLOYMENT;
  const applied = UPLC.applyParamsToScript(blueprint(), [
    Data.int(BigInt(deployment.requiredAdmins)),
    Data.list(deployment.adminVkeys.map((v) => Data.bytearray(v))),
    Data.int(BigInt(deployment.cooldownPeriod)),
  ]);
  // applyParamsToScript returns double-CBOR; PlutusV3 wants the single-wrapped script.
  const bytes = CBOR.fromCBORHex(applied);
  if (!(bytes instanceof Uint8Array)) throw new Error("Unexpected applied script encoding");
  return new PlutusV3.PlutusV3({ bytes });
}

export const scriptHashHex = (script: PlutusV3.PlutusV3) => ScriptHash.toHex(ScriptHash.fromScript(script));

const SLOT = SlotConfig.SLOT_CONFIG_NETWORK.Preprod;
/** After an action, the acting party waits this long before acting again (420 000 ms on preprod). */
const COOLDOWN_MS = BigInt(MASUMI_DEFAULT_DEPLOYMENT.cooldownPeriod);
/** The POSIX time scripts see for a validity bound: the start of its slot. */
export const slotStartMs = (ms: bigint) => Time.slotToUnixTime(Time.unixTimeToSlot(ms, SLOT), SLOT);
/** The first slot start at or after `ms`, for lower bounds that must clear a deadline. */
export const ceilToSlotMs = (ms: bigint) => (slotStartMs(ms) === ms ? ms : slotStartMs(ms) + BigInt(SLOT.slotLength));
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** Chain time from the latest block: validity windows come from it, not the local clock. */
async function tipMs(): Promise<bigint> {
  const block = await blockfrost<{ time: number }>("/blocks/latest");
  return BigInt(block!.time) * 1000n;
}

export function paymentKeyHash(address: string): string {
  const { payment } = addressCredentials(address);
  if (payment.isScript) throw new Error(`${address} has a script payment credential`);
  return payment.hash;
}

/** A datum address back as a ledger address (payment + stake parts). */
function datumAddress(a: MasumiDatumView["buyer"]): Address.Address {
  if (a.pointer) throw new Error("Pointer stake addresses are not supported");
  const credential = (c: { isScript: boolean; hash: string }) => (c.isScript ? ScriptHash.fromHex(c.hash) : KeyHash.fromHex(c.hash));
  return new Address.Address({ networkId: 0, paymentCredential: credential(a.payment), ...(a.stake ? { stakingCredential: credential(a.stake) } : {}) });
}

// ---------------------------------------------------------------- datum transitions

function withFields(lock: Data.Data, changes: Record<number, Data.Data>): Data.Data {
  if (!Data.isConstr(lock) || lock.index !== 0n || lock.fields.length !== 19) throw new Error("Not a vested_pay V2 datum");
  const fields = [...lock.fields];
  for (const [index, value] of Object.entries(changes)) fields[Number(index)] = value;
  return Data.constr(0n, fields);
}

/** SubmitResult: result_hash (11), seller_cooldown_time (16), buyer_cooldown_time (17) = 0, state (18) ResultSubmitted. */
export const submitResultDatum = (lock: Data.Data, resultHashHex: string, sellerCooldownTime: bigint) =>
  withFields(lock, { 11: Data.bytearray(resultHashHex), 16: Data.int(sellerCooldownTime), 17: Data.int(0n), 18: Data.constr(STATE.ResultSubmitted, []) });

/** AuthorizeRefund: result_hash empty, seller cooldown ≥ upper bound + cooldown, buyer cooldown 0, state RefundAuthorized. */
export const authorizeRefundDatum = (lock: Data.Data, sellerCooldownTime: bigint) =>
  withFields(lock, { 11: Data.bytearray(""), 16: Data.int(sellerCooldownTime), 17: Data.int(0n), 18: Data.constr(STATE.RefundAuthorized, []) });

/** SetRefundRequested: state (18) Disputed when a result hash is in, else RefundRequested; seller_cooldown_time (16) = 0, buyer_cooldown_time (17) set. */
export const refundRequestDatum = (lock: Data.Data, hasResult: boolean, buyerCooldownTime: bigint) =>
  withFields(lock, { 16: Data.int(0n), 17: Data.int(buyerCooldownTime), 18: Data.constr(hasResult ? STATE.Disputed : STATE.RefundRequested, []) });

// ---------------------------------------------------------------- reading the escrow

export interface EscrowUtxo {
  ref: string;
  utxo: UTxO.UTxO;
  datum: MasumiDatumView;
  data: Data.Data;
}

/** The unspent escrow output of `txHash` (a lock or a continuation), once the transaction is in a block. */
export async function escrowOutputOf(wallet: Wallet, txHash: string): Promise<EscrowUtxo | undefined> {
  await waitForTx(txHash);
  const rows = await blockfrost<{ outputs: { output_index: number; address: string; consumed_by_tx?: string | null; collateral?: boolean }[] }>(`/txs/${txHash}/utxos`);
  const row = rows?.outputs.find((r) => r.address === ESCROW_ADDRESS && !r.consumed_by_tx && !r.collateral);
  if (!row) return undefined;
  const input = new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(txHash), index: BigInt(row.output_index) });
  const [utxo] = await wallet.client().getUtxosByOutRef([input]);
  if (!utxo || !(utxo.datumOption instanceof InlineDatum.InlineDatum)) return undefined;
  const datum = parseMasumiLockDatum(utxo.datumOption.data);
  if (!datum) return undefined;
  return { ref: `${txHash}#${row.output_index}`, utxo, datum, data: utxo.datumOption.data };
}

// ---------------------------------------------------------------- seller actions

/** Seller: put the result hash on chain. Due before submit_result_time. */
export async function submitResult(seller: Wallet, lock: EscrowUtxo, resultHashHex: string): Promise<string> {
  const d = lock.datum;
  if (d.state !== STATE.FundsLocked || d.seller.payment.hash !== paymentKeyHash(seller.address)) throw new Error("Not a FundsLocked escrow of this seller");
  const now = await tipMs();
  const from = max(now - 60_000n, ceilToSlotMs(d.sellerCooldownTime));
  // The validator sees slotStart(to) and requires it before submit_result_time.
  const to = min(now + 300_000n, d.submitResultTime - 120_000n);
  if (to <= now + 30_000n || from >= to) throw new Error("The SubmitResult window has closed");
  const datum = submitResultDatum(lock.data, resultHashHex, slotStartMs(to) + COOLDOWN_MS);
  return seller.transact((tx) =>
    tx
      .collectFrom({ inputs: [lock.utxo], redeemer: REDEEMER.submitResult })
      .attachScript({ script: paymentScript() })
      .payToAddress({ address: lock.utxo.address, assets: lock.utxo.assets, autoMinUtxo: true, datum: new InlineDatum.InlineDatum({ data: datum }) })
      .addSigner({ keyHash: KeyHash.fromHex(paymentKeyHash(seller.address)) })
      .setValidity({ from, to }),
  );
}

/** Seller: give the money back (the work failed). The buyer can then refund at once. */
export async function authorizeRefund(seller: Wallet, lock: EscrowUtxo): Promise<string> {
  const d = lock.datum;
  if (d.seller.payment.hash !== paymentKeyHash(seller.address)) throw new Error("Not an escrow of this seller");
  const now = await tipMs();
  const from = max(now - 60_000n, ceilToSlotMs(d.sellerCooldownTime));
  const to = now + 300_000n;
  const datum = authorizeRefundDatum(lock.data, slotStartMs(to) + COOLDOWN_MS);
  return seller.transact((tx) =>
    tx
      .collectFrom({ inputs: [lock.utxo], redeemer: REDEEMER.authorizeRefund })
      .attachScript({ script: paymentScript() })
      .payToAddress({ address: lock.utxo.address, assets: lock.utxo.assets, autoMinUtxo: true, datum: new InlineDatum.InlineDatum({ data: datum }) })
      .addSigner({ keyHash: KeyHash.fromHex(paymentKeyHash(seller.address)) })
      .setValidity({ from, to }),
  );
}

/** Seller: collect a ResultSubmitted escrow from unlock_time. The buyer's deposit goes back tagged with the lock's out-ref. */
export async function collect(seller: Wallet, lock: EscrowUtxo): Promise<string> {
  const d = lock.datum;
  if (d.state !== STATE.ResultSubmitted) throw new Error("The escrow is not in ResultSubmitted");
  const now = await tipMs();
  const from = ceilToSlotMs(d.unlockTime);
  if (now < from) throw new Error(`Unlocks at ${new Date(Number(from)).toLocaleTimeString()}`);
  const [txHash, index] = lock.ref.split("#") as [string, string];
  return seller.transact((tx) => {
    tx = tx
      .collectFrom({ inputs: [lock.utxo], redeemer: REDEEMER.withdraw })
      .attachScript({ script: paymentScript() })
      .addSigner({ keyHash: KeyHash.fromHex(paymentKeyHash(seller.address)) })
      .setValidity({ from, to: now + 300_000n });
    if (d.collateralReturnLovelace > 0n) {
      tx = tx.payToAddress({
        address: datumAddress(d.buyerReturnAddress ?? d.buyer),
        assets: Assets.fromLovelace(d.collateralReturnLovelace),
        // Plutus V3 OutputReference { transaction_id, output_index } = Constr 0 [bytes, int]
        datum: new InlineDatum.InlineDatum({ data: Data.constr(0n, [Data.bytearray(txHash), Data.int(BigInt(index))]) }),
        autoMinUtxo: true,
      });
    }
    // The bounty (tUSDM and the remaining lovelace) returns to the seller as change.
    return tx;
  });
}

// ---------------------------------------------------------------- buyer action

/** Buyer: take the money back. At once after authorizeRefund; otherwise from submit_result_time if no result was submitted. */
export async function withdrawRefund(buyer: Wallet, lock: EscrowUtxo): Promise<string> {
  const d = lock.datum;
  if (d.buyer.payment.hash !== paymentKeyHash(buyer.address)) throw new Error("Not an escrow of this buyer");
  if (d.resultHash !== "") throw new Error("A result was submitted; the seller collects this escrow");
  const now = await tipMs();
  let from = now - 60_000n;
  if (d.state !== STATE.RefundAuthorized) {
    from = ceilToSlotMs(d.submitResultTime);
    if (now < from) throw new Error(`Refundable from ${new Date(Number(from)).toLocaleTimeString()} (submit-result deadline)`);
  }
  // No buyer_return_address: the buyer's signature is the only gate, so everything returns as change.
  return buyer.transact((tx) =>
    tx
      .collectFrom({ inputs: [lock.utxo], redeemer: REDEEMER.withdrawRefund })
      .attachScript({ script: paymentScript() })
      .addSigner({ keyHash: KeyHash.fromHex(paymentKeyHash(buyer.address)) })
      .setValidity({ from, to: now + 300_000n }),
  );
}

/**
 * Buyer: dispute before unlock_time. With a result hash in the escrow it moves to
 * Disputed: the seller can no longer collect, and Masumi's admins settle it.
 * Without one it moves to RefundRequested.
 */
export async function requestRefund(buyer: Wallet, lock: EscrowUtxo): Promise<string> {
  const d = lock.datum;
  if (d.buyer.payment.hash !== paymentKeyHash(buyer.address)) throw new Error("Not an escrow of this buyer");
  if (d.state !== STATE.FundsLocked && d.state !== STATE.ResultSubmitted && d.state !== STATE.Disputed) throw new Error("This escrow cannot be disputed in its state");
  const now = await tipMs();
  const from = max(now - 60_000n, ceilToSlotMs(d.buyerCooldownTime));
  // The validator sees slotStart(to) and requires it before unlock_time.
  const to = min(now + 300_000n, d.unlockTime - 120_000n);
  if (to <= now + 30_000n || from >= to) throw new Error("The dispute window has closed (unlock time)");
  const datum = refundRequestDatum(lock.data, d.resultHash !== "", slotStartMs(to) + COOLDOWN_MS);
  return buyer.transact((tx) =>
    tx
      .collectFrom({ inputs: [lock.utxo], redeemer: REDEEMER.setRefundRequested })
      .attachScript({ script: paymentScript() })
      .payToAddress({ address: lock.utxo.address, assets: lock.utxo.assets, autoMinUtxo: true, datum: new InlineDatum.InlineDatum({ data: datum }) })
      .addSigner({ keyHash: KeyHash.fromHex(paymentKeyHash(buyer.address)) })
      .setValidity({ from, to }),
  );
}

// ---------------------------------------------------------------- checking a lock

/** The Masumi terms the seller signed for a lock (x402 `extra.terms`). */
export interface EscrowTerms {
  sellerAddress: string;
  sellerNonce: string;
  submitResultTime: string;
  unlockTime: string;
}

export const termsOf = (settled: Settled) => (settled.requirements.extra as { terms: EscrowTerms }).terms;

/**
 * Seller: the lock must be exactly what it signed before it spends anything on
 * the job. Waits for the lock to confirm; throws if anything differs.
 */
export async function confirmLock(seller: Wallet, settled: Settled, price: Amount): Promise<EscrowUtxo> {
  const terms = termsOf(settled);
  const lock = await escrowOutputOf(seller, settled.tx);
  const d = lock?.datum;
  const locked = lock ? Assets.getByUnit(lock.utxo.assets, toUnit(price.asset)) : 0n;
  const mismatch = !lock || !d ? "no escrow output in the lock transaction"
    : d.seller.payment.hash !== paymentKeyHash(seller.address) ? "the escrow names another seller"
    : d.state !== STATE.FundsLocked || d.resultHash !== "" ? "the escrow is not freshly locked"
    : d.sellerNonce !== terms.sellerNonce || d.submitResultTime !== BigInt(terms.submitResultTime) || d.unlockTime !== BigInt(terms.unlockTime) ? "the escrow terms differ from the signed terms"
    : locked < price.amount ? `the escrow holds less than ${formatAmount(price.asset, price.amount)}`
    : undefined;
  if (mismatch || !lock) throw new Error(`refusing the job: ${mismatch}`);
  return lock;
}

// ---------------------------------------------------------------- job records

/** What the buyer and the collect/refund commands need to follow an escrowed job. */
export interface EscrowJob {
  jobId: string;
  task: string;
  /** Wallet role of the seller (it collects) and of the buyer (it refunds). */
  seller: string;
  buyer: string;
  /** "vanished" only in demos: the seller took the job and never delivers. */
  status: "awaiting_lock" | "locked" | "vanished" | "working" | "result_submitted" | "refund_authorized" | "disputed" | "collected" | "refunded" | "failed";
  lockTx?: string;
  /** Latest transaction that holds the escrow output. */
  escrowTx?: string;
  amount: string;
  submitResultTime?: number;
  unlockTime?: number;
  resultHash?: string;
  /** What the result hash commits to (app-specific, canonical JSON). */
  result?: unknown;
  /** One line for people: what was delivered, or why not. */
  summary?: string;
  receiptTx?: string;
  error?: string;
  history: { action: string; tx: string; at: string }[];
}

const jobDir = () => path.join(ROOT, ".cache", "escrow", appName());

export function saveJob(job: EscrowJob) {
  mkdirSync(jobDir(), { recursive: true });
  writeFileSync(path.join(jobDir(), `${job.jobId}.json`), JSON.stringify(job, null, 2));
}

export function loadJob(jobId: string): EscrowJob | undefined {
  const file = path.join(jobDir(), `${jobId}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as EscrowJob) : undefined;
}

export function listJobs(): EscrowJob[] {
  if (!existsSync(jobDir())) return [];
  return readdirSync(jobDir()).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(jobDir(), f), "utf8")) as EscrowJob);
}

export function record(job: EscrowJob, action: string, tx: string) {
  job.history.push({ action, tx, at: new Date().toISOString() });
  job.escrowTx = tx;
  saveJob(job);
}

/** Open jobs: when the next step becomes possible (ms) and who takes it. */
export function nextStep(job: EscrowJob): { at: number; action: "collect" | "refund" } | undefined {
  if (job.status === "result_submitted") return { at: job.unlockTime!, action: "collect" };
  if (job.status === "refund_authorized") return { at: 0, action: "refund" };
  // A job that failed before its result hash reached the escrow is refundable like a no-show.
  const undelivered = ["locked", "vanished", "working"].includes(job.status) || (job.status === "failed" && Boolean(job.lockTx) && !job.resultHash);
  if (undelivered && job.submitResultTime) return { at: job.submitResultTime, action: "refund" };
  return undefined;
}
