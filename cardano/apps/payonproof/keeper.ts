/**
 * Keeper agent: sells "execute this order if its condition holds" over x402.
 *
 * Every attempt carries a signed Cardano fee. The Keeper fetches a Nodary-signed
 * EUR/USD rate; if the rate is not below the order's limit it answers 409 and
 * x402 never submits the fee. If it is, the Keeper submits the signed rate to
 * the escrow, which checks it and pays the invoice; only that success (200)
 * settles the fee. Once the fee settled, the Keeper publishes a receipt on
 * Cardano. No LLM here: the signed number and the contract decide.
 */
import type { Request, Response } from "express";
import { Seller, ada, emit, formatAmount, publish, type Settled, type Wallet } from "@agentic/core";
import { ESCROW_NODE, STATUS, fetchSignedRate, invoiceRefOf, showRate, usd, type Evm } from "./evm.ts";
import { ADDRESS_BOOK } from "./lena.ts";

export const KEEPER_FEE = ada(2);
export const KEEPER_PORT = 4110;

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
}

/** Display name of an EVM payee (the suppliers are public counterparties). */
const payeeName = (address: string) =>
  Object.values(ADDRESS_BOOK).find((s) => s.address.toLowerCase() === address.toLowerCase())?.name ?? `${address.slice(0, 8)}…`;

export async function startKeeper(keeper: Wallet, evm: Evm, options: { port?: number; receipts?: boolean } = {}) {
  const fee = formatAmount(KEEPER_FEE.asset, KEEPER_FEE.amount);
  const pending = new Set<Promise<unknown>>();

  const shop = new Seller(keeper).paid(
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
        const result = await evm.execute(orderId, checked.signed);
        const ref = evm.txRef(result.hash);
        const supplier = payeeName(order.payee);
        emit({
          kind: "task.done", actor: keeper.name, task: invoice, link: ref.link, linkLabel: ref.link ? "escrow tx on basescan ↗" : undefined,
          message: `${invoice} paid on ${evm.name}: the escrow verified the signed rate and paid ${usd(result.payout)} to ${supplier}, refunding ${usd(result.refund)} to Lena${ref.note}`,
          data: { evmTx: result.hash, payout: String(result.payout), refund: String(result.refund), rate: checked.display },
        });
        emit({ kind: "payment.external", actor: ESCROW_NODE, task: invoice, from: ESCROW_NODE, to: supplier, amount: usd(result.payout), link: ref.link, linkLabel: ref.link ? "basescan ↗" : undefined, message: `${ESCROW_NODE} paid ${usd(result.payout)} to ${supplier} (${invoice}, at EUR/USD ${checked.display})${ref.note}` });
        if (result.refund > 0n) emit({ kind: "payment.external", actor: ESCROW_NODE, task: invoice, from: ESCROW_NODE, to: "Lena's finance agent", amount: usd(result.refund), link: ref.link, linkLabel: ref.link ? "basescan ↗" : undefined, message: `${ESCROW_NODE} refunded ${usd(result.refund)} to Lena (${invoice})${ref.note}` });
        const body: Executed = {
          status: "executed", invoice, orderId: String(orderId), payee: supplier, amountEurCents: String(order.amountEurCents), rate: checked.display,
          payout: String(result.payout), refund: String(result.refund), network: evm.name, evmTx: result.hash, link: evm.txLink(result.hash),
        };
        return res.json({ ...condition, ...body });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        emit({ kind: "task.failed", actor: keeper.name, task: invoice, message: `${invoice}: execution failed (${reason}); HTTP 502, fee voided` });
        return res.status(502).json({ status: "execution_failed", reason });
      }
    },
  );

  // Only after the fee settled: a public receipt linking the fee to the payment it bought.
  shop.onSettled((settled: Settled) => {
    const body = settled.body as Executed | undefined;
    if (options.receipts === false || body?.status !== "executed") return;
    const work = publishReceipt(keeper, evm, body, settled.tx).catch((error) => console.warn(`  ! receipt not published: ${error instanceof Error ? error.message : String(error)}`));
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });

  const server = await shop.listen(options.port ?? KEEPER_PORT);
  return {
    ...server,
    /** Waits for receipts still being published. */
    idle: async () => {
      while (pending.size) await Promise.all(pending);
    },
  };
}

/**
 * The Keeper's CIP-20 receipt: a public track record that links each paid fee
 * to the escrow payment it bought. Costs the Keeper about 0.2 tADA.
 */
async function publishReceipt(keeper: Wallet, evm: Evm, receipt: Executed, feeTx: string) {
  const euros = `€${(Number(receipt.amountEurCents) / 100).toLocaleString("en-US")}`;
  return publish(keeper, [
    `PayOnProof receipt ${receipt.invoice}, order ${receipt.orderId} on ${receipt.network}`,
    `Paid ${usd(BigInt(receipt.payout))} to ${receipt.payee}`,
    `= ${euros} x EUR/USD ${receipt.rate} (API3 Nodary-signed)`,
    `escrow ${evm.escrow}`,
    `escrow tx (${receipt.network}):`,
    receipt.evmTx.replace(/^0x/, ""),
    "x402 fee tx (Cardano preprod):",
    feeTx,
  ], { task: receipt.invoice, title: `a receipt for ${receipt.invoice}` });
}
