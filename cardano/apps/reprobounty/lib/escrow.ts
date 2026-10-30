/**
 * Masumi escrow (`vested_pay`, payment V2) for the bounty. x402 makes the lock
 * (core `Seller` route with `escrow: true`); this file has the transactions
 * after it, built with evolution-sdk and evaluated by Blockfrost during build(),
 * so a rule violation throws before anything is signed.
 *
 *   seller  submitResult     FundsLocked → ResultSubmitted: the result hash goes on chain
 *           collect          Withdraw from unlock_time: bounty to the seller, deposit back to the buyer
 *           authorizeRefund  FundsLocked → RefundAuthorized: the work failed, the seller gives the money back
 *   buyer   withdrawRefund   at once after authorizeRefund; from submit_result_time if the seller never delivered
 *
 * Seller-side builders follow reference/x402-cardano-demo/masumi/src/chain.ts;
 * the refund actions follow the validator source (vested_pay.ak, AuthorizeRefund
 * and WithdrawRefund branches).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Address, Assets, CBOR, Data, InlineDatum, KeyHash, PlutusV3, ScriptHash, SlotConfig, Time, TransactionHash, TransactionInput, UPLC, type UTxO } from "@evolution-sdk/evolution";
import { MASUMI_DEFAULT_DEPLOYMENT, addressCredentials, masumiEscrowAddress, parseMasumiLockDatum, type MasumiDatumView } from "@x402/cardano";
import { NETWORK, ROOT, blockfrost, waitForTx, type Wallet } from "@agentic/core";

export const ESCROW_ADDRESS = masumiEscrowAddress(NETWORK);

/** vested_pay states (datum field 18). */
export const STATE = { FundsLocked: 0n, ResultSubmitted: 1n, RefundRequested: 2n, Disputed: 3n, WithdrawAuthorized: 4n, RefundAuthorized: 5n } as const;

/** vested_pay redeemers: the constructor index of the action. */
const REDEEMER = {
  withdraw: Data.constr(0n, []),
  withdrawRefund: Data.constr(3n, []),
  submitResult: Data.constr(5n, []),
  authorizeRefund: Data.constr(6n, []),
};

// ---------------------------------------------------------------- script and time

const blueprint = () =>
  (JSON.parse(readFileSync(new URL("../contracts/payment-v2.plutus.json", import.meta.url), "utf8")) as { validators: { compiledCode: string }[] }).validators[0]!.compiledCode;

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

// ---------------------------------------------------------------- job records

/** What the requester and the collect/refund commands need to follow an escrowed job. */
export interface EscrowJob {
  jobId: string;
  task: string;
  status: "awaiting_lock" | "locked" | "working" | "result_submitted" | "refund_authorized" | "collected" | "refunded" | "failed";
  lockTx?: string;
  /** Latest transaction that holds the escrow output. */
  escrowTx?: string;
  amount: string;
  submitResultTime?: number;
  unlockTime?: number;
  resultHash?: string;
  verdict?: string;
  certificateTx?: string;
  error?: string;
  history: { action: string; tx: string; at: string }[];
}

const JOB_DIR = path.join(ROOT, ".cache", "escrow");

export function saveJob(job: EscrowJob) {
  mkdirSync(JOB_DIR, { recursive: true });
  writeFileSync(path.join(JOB_DIR, `${job.jobId}.json`), JSON.stringify(job, null, 2));
}

export function loadJob(jobId: string): EscrowJob | undefined {
  const file = path.join(JOB_DIR, `${jobId}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as EscrowJob) : undefined;
}

export function listJobs(): EscrowJob[] {
  if (!existsSync(JOB_DIR)) return [];
  return readdirSync(JOB_DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(JOB_DIR, f), "utf8")) as EscrowJob);
}

export function record(job: EscrowJob, action: string, tx: string) {
  job.history.push({ action, tx, at: new Date().toISOString() });
  job.escrowTx = tx;
  saveJob(job);
}
