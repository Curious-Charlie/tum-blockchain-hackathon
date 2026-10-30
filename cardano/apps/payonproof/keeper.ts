/**
 * Keeper agent: executes an invoice order on the EVM chain when its EUR/USD
 * condition holds, on a Nodary-signed rate. No LLM here: the signed number and
 * the contract decide. Two ways to hire it:
 *
 * - `POST /orders/:id/watch` (default): Lena locks the Keeper's fee in Masumi
 *   escrow first (x402, `escrow: true`). Once the lock is on chain the Keeper
 *   watches the order over several cycles; when the condition holds it executes
 *   on the EVM chain and puts the result hash (sha256 of the execution proof,
 *   proof.ts) into the escrow, then collects after the unlock time. If the
 *   condition never holds within the watch window it authorizes a refund.
 *   Before it executes, it buys a second signed rate over x402 on AirnodeHub
 *   (crosscheck.ts) and acts only if the two sources agree.
 *   `GET /jobs/:id` reports the job.
 * - `POST /orders/:id/execute`: one attempt per request with a signed x402 fee in
 *   tADA. Condition not met → HTTP 409 and the fee is never submitted; executed
 *   → HTTP 200 and the fee settles.
 *
 * After it is paid the Keeper publishes a receipt on Cardano (CIP-20): its public
 * track record, which buyers check against the EVM chain (records.ts).
 * `GET /profile` proves which EVM account the Keeper executes from.
 */
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { Seller, ada, emit, formatAmount, publish, sleep, type Amount, type Settled, type Wallet } from "@agentic/core";
import { authorizeRefund, confirmLock, record, saveJob, loadJob, submitResult, termsOf, type EscrowJob } from "@agentic/core/escrow";
import { MAX_DEVIATION, buySecondRate, type SecondRate } from "./crosscheck.ts";
import { ESCROW_NODE, STATUS, fetchSignedRate, invoiceRefOf, keeperKey, showRate, usd, type Evm, type Order } from "./evm.ts";
import { ADDRESS_BOOK } from "./lena.ts";
import { proofFromChain, proofHash } from "./proof.ts";
import { bindingMessage } from "./records.ts";

export const KEEPER_FEE = ada(2);
export const KEEPER_PORT = 4110;

/** The Keepers of the demo: same service, different prices for the escrowed watch job. */
export const KEEPER_ROLES = ["KEEPER", "KEEPER_B", "KEEPER_C"] as const;

/** What Lena asks for when she hires a Keeper to watch an order. */
export interface WatchRequest {
  task: string;
  /** How long the Keeper keeps checking before it gives the fee back. */
  watchMinutes: number;
}

/** What the Keeper answers after an execution; also the input of its receipt. */
interface Executed {
  status: "executed";
  invoice: string;
  orderId: string;
  payee: string;
  amountEurCents: string;
  rate: string;
  payout: string;
  refund: string;
  network: string;
  evmTx: string;
  link: string;
  /** The second signed rate the Keeper bought before executing, if any. */
  crossCheck?: SecondRate;
}

/** Display name of an EVM payee (the suppliers are public counterparties). */
const payeeName = (address: string) =>
  Object.values(ADDRESS_BOOK).find((s) => s.address.toLowerCase() === address.toLowerCase())?.name ?? `${address.slice(0, 8)}…`;

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export async function startKeeper(
  keeper: Wallet,
  evm: Evm,
  options: { port?: number; receipts?: boolean; escrowFee?: Amount; intervalSec?: number; vanish?: boolean; crossCheck?: boolean } = {},
) {
  const fee = formatAmount(KEEPER_FEE.asset, KEEPER_FEE.amount);
  const escrowFee = options.escrowFee ?? ada(2);
  const escrowPrice = formatAmount(escrowFee.asset, escrowFee.amount);
  const interval = (options.intervalSec ?? 15) * 1000;
  const evmAddress = evm.keeperAddressOf(keeper.role);
  const pending = new Set<Promise<unknown>>();
  const background = (work: Promise<unknown>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  /** Submits the signed rate to the escrow contract and shows the payment on the dashboard. */
  async function executeOrder(orderId: bigint, order: Order, checked: Awaited<ReturnType<typeof fetchSignedRate>>, invoice: string) {
    const result = await evm.execute(orderId, checked.signed, keeper.role);
    const ref = evm.txRef(result.hash);
    const supplier = payeeName(order.payee);
    emit({
      kind: "task.done", actor: keeper.name, task: invoice, link: ref.link, linkLabel: ref.link ? "escrow tx on basescan ↗" : undefined,
      message: `${invoice} paid on ${evm.name}: the escrow verified the signed rate and paid ${usd(result.payout)} to ${supplier}, refunding ${usd(result.refund)} to Lena${ref.note}`,
      data: { evmTx: result.hash, payout: String(result.payout), refund: String(result.refund), rate: checked.display },
    });
    emit({ kind: "payment.external", actor: ESCROW_NODE, task: invoice, from: ESCROW_NODE, to: supplier, amount: usd(result.payout), link: ref.link, linkLabel: ref.link ? "basescan ↗" : undefined, message: `${ESCROW_NODE} paid ${usd(result.payout)} to ${supplier} (${invoice}, at EUR/USD ${checked.display})${ref.note}` });
    if (result.refund > 0n) emit({ kind: "payment.external", actor: ESCROW_NODE, task: invoice, from: ESCROW_NODE, to: "Lena's finance agent", amount: usd(result.refund), link: ref.link, linkLabel: ref.link ? "basescan ↗" : undefined, message: `${ESCROW_NODE} refunded ${usd(result.refund)} to Lena (${invoice})${ref.note}` });
    const executed: Executed = {
      status: "executed", invoice, orderId: String(orderId), payee: supplier, amountEurCents: String(order.amountEurCents), rate: checked.display,
      payout: String(result.payout), refund: String(result.refund), network: evm.name, evmTx: result.hash, link: evm.txLink(result.hash),
    };
    return executed;
  }

  const shop = new Seller(keeper);

  // ------------------------------------------------------------ x402: one paid attempt per request

  shop.paid(
    "POST /orders/:id/execute",
    { price: KEEPER_FEE, description: `PayOnProof: execute an invoice order if its EUR/USD condition holds (${fee}, charged only on success)` },
    async (req: Request, res: Response) => {
      const orderId = BigInt(String(req.params.id));
      const order = await evm.getOrder(orderId);
      const invoice = order.status ? invoiceRefOf(order) : `order ${orderId}`;
      const step = (message: string, data?: Record<string, unknown>) => emit({ kind: "task.step", actor: keeper.name, task: invoice, message, data });

      if (STATUS[order.status] !== "Open") {
        step(`${invoice} is ${STATUS[order.status] ?? "unknown"}: nothing to execute (HTTP 409, fee not charged)`);
        return res.status(409).json({ status: "not_open", order: STATUS[order.status] });
      }

      const checked = await fetchSignedRate();
      const limit = showRate(order.maxRate);
      const age = Math.max(0, Math.round(Date.now() / 1000) - checked.signedAt);
      const condition = { rate: checked.display, limit, signedAt: checked.signedAt, airnode: checked.signed.airnode };

      if (checked.rate >= order.maxRate) {
        step(`Nodary-signed EUR/USD ${checked.display} (signed ${age}s ago) is not below ${limit}: condition not met, HTTP 409, fee voided`, condition);
        return res.status(409).json({ status: "condition_not_met", ...condition });
      }

      step(`Nodary-signed EUR/USD ${checked.display} < ${limit}: submitting the signed rate to the escrow on ${evm.name}`, condition);
      try {
        const body = await executeOrder(orderId, order, checked, invoice);
        return res.json({ ...condition, ...body });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        emit({ kind: "task.failed", actor: keeper.name, task: invoice, message: `${invoice}: execution failed (${reason}); HTTP 502, fee voided` });
        return res.status(502).json({ status: "execution_failed", reason });
      }
    },
  );

  // ------------------------------------------------------------ Masumi escrow: fee locked first, then the watch job

  const watches = new Map<string, { orderId: bigint; watchMinutes: number }>();

  shop.paid(
    "POST /orders/:id/watch",
    { price: escrowFee, description: `PayOnProof: watch an invoice order and execute it when its EUR/USD condition holds (${escrowPrice}, locked in Masumi escrow, released after execution)`, escrow: true },
    async (req: Request, res: Response) => {
      const orderId = BigInt(String(req.params.id));
      const { task, watchMinutes } = req.body as WatchRequest;
      const order = await evm.getOrder(orderId);
      if (STATUS[order.status] !== "Open" || Number(order.deadline) * 1000 < Date.now()) {
        return res.status(409).json({ status: "not_open", order: STATUS[order.status] });
      }
      const minutes = Math.min(Math.max(Number(watchMinutes) || 10, 1), 12);
      const job: EscrowJob = { jobId: randomUUID(), task: task ?? invoiceRefOf(order), seller: keeper.role, buyer: "LENA", status: "awaiting_lock", amount: escrowPrice, history: [] };
      watches.set(job.jobId, { orderId, watchMinutes: minutes });
      saveJob(job);
      emit({ kind: "task.step", actor: keeper.name, task: job.task, message: `Job ${job.jobId.slice(0, 8)} accepted: watch ${invoiceRefOf(order)} for ${minutes} min. The ${escrowPrice} fee goes into Masumi escrow first; the Keeper starts once the lock is on chain` });
      res.status(202).json({ jobId: job.jobId, status: job.status, evmAddress });
    },
  );

  shop.app.get("/jobs/:id", (req, res) => {
    const job = loadJob(req.params.id);
    if (job) res.json(job);
    else res.status(404).json({ error: "unknown job" });
  });

  // Proof of which EVM account this Keeper executes from (signed with that account's key).
  const binding = await evm.signAsKeeper(keeper.role, bindingMessage(keeper.address, evmAddress));
  shop.app.get("/profile", (_req, res) => {
    res.json({ role: keeper.role, name: keeper.name, cardano: keeper.address, evm: evmAddress, network: evm.name, binding });
  });

  async function runWatch(job: EscrowJob, watch: { orderId: bigint; watchMinutes: number }, settled: Settled) {
    const { task } = job;
    const step = (message: string, extra: { tx?: string; data?: Record<string, unknown> } = {}) => emit({ kind: "task.step", actor: keeper.name, task, message, ...extra });
    const terms = termsOf(settled);
    job.lockTx = settled.tx;
    job.status = "locked";
    job.submitResultTime = Number(terms.submitResultTime);
    job.unlockTime = Number(terms.unlockTime);
    record(job, "lock", settled.tx);
    step(`Fee locked in Masumi escrow (${escrowPrice}). Result due by ${clock(job.submitResultTime)}, collectable from ${clock(job.unlockTime)}. Waiting for the lock to confirm…`);
    const lock = await confirmLock(keeper, settled, escrowFee);
    step(`Lock confirmed: ${escrowPrice} in escrow ${lock.ref.slice(0, 12)}…, the terms match what the Keeper signed`);

    if (options.vanish) {
      job.status = "vanished";
      saveJob(job);
      emit({ kind: "task.step", actor: keeper.name, task, message: `⚠ DEMO --vanish: ${keeper.name} takes the job and disappears. Nothing reaches the escrow, so Lena can take her ${escrowPrice} back from ${clock(job.submitResultTime)}` });
      return;
    }

    job.status = "working";
    saveJob(job);
    // Stop early enough to put the result hash in before the escrow's deadline.
    const until = Math.min(Date.now() + watch.watchMinutes * 60_000, job.submitResultTime - 4 * 60_000);
    let reason = `EUR/USD did not drop below the limit before ${clock(until)}`;
    for (let cycle = 1; ; cycle++) {
      const order = await evm.getOrder(watch.orderId);
      const invoice = invoiceRefOf(order);
      if (STATUS[order.status] !== "Open") {
        reason = `${invoice} is ${STATUS[order.status]}`;
        break;
      }
      const limit = showRate(order.maxRate);
      const checked = await fetchSignedRate().catch((error) => {
        step(`Cycle ${cycle}: no signed rate from Nodary (${error instanceof Error ? error.message : String(error)})`);
        return undefined;
      });
      const second = checked && checked.rate < order.maxRate ? await secondOpinion(cycle, checked.display, task) : undefined;
      if (checked && checked.rate < order.maxRate && second !== "disagree") {
        step(`Cycle ${cycle}: Nodary-signed EUR/USD ${checked.display} < ${limit}: executing ${invoice} on ${evm.name}`, { data: { rate: checked.display, limit, signedAt: checked.signedAt } });
        try {
          const executed = { ...(await executeOrder(watch.orderId, order, checked, invoice)), crossCheck: second };
          const proof = await proofFromChain(evm, executed.evmTx as `0x${string}`, job.lockTx!);
          if (!proof) throw new Error(`no InvoicePaid event in ${executed.evmTx}`);
          const hash = proofHash(proof);
          step(`Result hash ${hash.slice(0, 16)}… = sha256 of the execution proof (execute tx, InvoicePaid event, fee lock). Putting it into the Masumi escrow…`, { data: { proof } });
          const tx = await submitResult(keeper, lock, hash);
          Object.assign(job, { status: "result_submitted", resultHash: hash, result: proof, summary: `${invoice}: paid ${usd(BigInt(executed.payout))} to ${executed.payee} at EUR/USD ${executed.rate}` });
          record(job, "submit_result", tx);
          emit({ kind: "task.done", actor: keeper.name, task, tx, message: `Result hash is in the escrow. ${keeper.name} can collect the ${escrowPrice} from ${clock(job.unlockTime)}, after Lena's dispute window` });
          if (options.receipts !== false) {
            const receipt = await publishReceipt(keeper, evm, executed, { lockTx: job.lockTx!, resultHash: hash, resultTx: tx });
            job.receiptTx = receipt.tx;
            saveJob(job);
          }
          return;
        } catch (error) {
          step(`Cycle ${cycle}: execution failed (${error instanceof Error ? error.message : String(error)}); still watching`);
        }
      } else if (checked && checked.rate >= order.maxRate) {
        const age = Math.max(0, Math.round(Date.now() / 1000) - checked.signedAt);
        step(`Cycle ${cycle}: Nodary-signed EUR/USD ${checked.display} (signed ${age}s ago) is not below ${limit}; next check in ${interval / 1000}s, watching until ${clock(until)}`);
      }
      if (Date.now() + interval > until) break;
      await sleep(interval);
    }

    job.summary = reason;
    step(`${reason}: authorizing a refund in the escrow, so Lena gets her ${escrowPrice} back at once`);
    const tx = await authorizeRefund(keeper, lock);
    job.status = "refund_authorized";
    record(job, "authorize_refund", tx);
    emit({ kind: "task.step", actor: keeper.name, task, tx, message: `Refund authorized in the escrow: Lena can withdraw her ${escrowPrice} now` });
  }

  /**
   * Buys a second signed EUR/USD (Frankfurter on AirnodeHub, 0.01 aUSD over x402) before money moves.
   * "disagree" if it differs from Nodary's by more than 1 %; undefined if it could not be bought
   * (the Keeper then relies on Nodary alone, as the contract does).
   */
  async function secondOpinion(cycle: number, nodary: string, task: string): Promise<SecondRate | "disagree" | undefined> {
    if (options.crossCheck === false) return undefined;
    const step = (message: string) => emit({ kind: "task.step", actor: keeper.name, task, message });
    try {
      const second = await buySecondRate(keeperKey(keeper.role));
      const ref = second.paymentTx ? evm.txRef(second.paymentTx) : { note: "" };
      emit({ kind: "payment.external", actor: keeper.name, task, from: keeper.name, to: "AirnodeHub: Frankfurter", amount: "0.01 aUSD", link: ref.link, linkLabel: ref.link ? "basescan ↗" : undefined, message: `${keeper.name} bought a second signed EUR/USD from Frankfurter on AirnodeHub over x402 (0.01 aUSD)${ref.note}` });
      const deviation = Math.abs(second.rate - Number(nodary)) / Number(nodary);
      const text = `Frankfurter ${second.rate} (${second.date}) vs Nodary ${nodary}: ${(deviation * 100).toFixed(2)} % apart`;
      if (deviation > MAX_DEVIATION) {
        step(`Cycle ${cycle}: the two signed sources disagree (${text}, more than ${MAX_DEVIATION * 100} %): not executing this cycle`);
        return "disagree";
      }
      step(`Cycle ${cycle}: second source agrees (${text}, limit ${MAX_DEVIATION * 100} %)`);
      return second;
    } catch (error) {
      step(`Cycle ${cycle}: could not buy a second rate (${error instanceof Error ? error.message : String(error)}); relying on Nodary alone, as the contract does`);
      return undefined;
    }
  }

  shop.onSettled((settled: Settled) => {
    // Escrow job: the lock settled, the watch starts.
    if (/^\/orders\/\d+\/watch$/.test(settled.path)) {
      const { jobId } = (settled.body ?? {}) as { jobId?: string };
      const job = jobId ? loadJob(jobId) : undefined;
      const watch = jobId ? watches.get(jobId) : undefined;
      if (!job || !watch) return;
      background(runWatch(job, watch, settled).catch((error) => {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        saveJob(job);
        emit({ kind: "task.failed", actor: keeper.name, task: job.task, message: `Escrow job failed: ${job.error}` });
      }));
      return;
    }
    // x402 attempt: only after the fee settled, a public receipt linking the fee to the payment it bought.
    const body = settled.body as Executed | undefined;
    if (options.receipts === false || body?.status !== "executed") return;
    background(publishReceipt(keeper, evm, body, { feeTx: settled.tx }).catch((error) => console.warn(`  ! receipt not published: ${error instanceof Error ? error.message : String(error)}`)));
  });

  const server = await shop.listen(options.port ?? KEEPER_PORT);
  return {
    ...server,
    evmAddress,
    /** Waits for jobs and receipts still running. */
    idle: async () => {
      while (pending.size) await Promise.all(pending);
    },
  };
}

/**
 * The Keeper's CIP-20 receipt: a public track record that links each paid fee
 * to the escrow payment it bought. Costs the Keeper about 0.2 tADA.
 */
async function publishReceipt(keeper: Wallet, evm: Evm, receipt: Executed, paid: { feeTx: string } | { lockTx: string; resultHash: string; resultTx: string }) {
  const euros = `€${(Number(receipt.amountEurCents) / 100).toLocaleString("en-US")}`;
  const fee = "feeTx" in paid
    ? ["x402 fee tx (Cardano preprod):", paid.feeTx]
    : ["fee locked in Masumi escrow, lock tx:", paid.lockTx, "result hash (sha256 of the execution proof):", paid.resultHash, "result submitted in tx:", paid.resultTx];
  const second = receipt.crossCheck ? [`cross-checked: Frankfurter ${receipt.crossCheck.rate} (${receipt.crossCheck.date}), x402`] : [];
  return publish(keeper, [
    `PayOnProof receipt ${receipt.invoice}, order ${receipt.orderId} on ${receipt.network}`,
    `Paid ${usd(BigInt(receipt.payout))} to ${receipt.payee}`,
    `= ${euros} x EUR/USD ${receipt.rate} (API3 Nodary-signed)`,
    ...second,
    `escrow ${evm.escrow}`,
    `escrow tx (${receipt.network}):`,
    receipt.evmTx.replace(/^0x/, ""),
    ...fee,
  ], { task: receipt.invoice, title: `a receipt for ${receipt.invoice}` });
}
