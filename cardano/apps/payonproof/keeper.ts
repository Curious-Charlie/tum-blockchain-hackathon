/**
 * Keeper agent: sells "execute this order if its condition holds" over x402.
 *
 * Every attempt carries a signed Cardano fee. The Keeper fetches a Nodary-signed
 * EUR/USD rate; if the rate is not below the order's limit it answers 409 and
 * x402 never submits the fee. If it is, the Keeper submits the signed rate to
 * the escrow, which checks it and pays the invoice; only that success (200)
 * settles the fee. No LLM here: the signed number and the contract decide.
 */
import type { Request, Response } from "express";
import { Seller, ada, emit, formatAmount, publish, type Wallet } from "@agentic/core";
import { STATUS, fetchSignedRate, invoiceRefOf, showRate, usd, type Evm } from "./evm.ts";

export const KEEPER_FEE = ada(2);
export const KEEPER_PORT = 4110;

export async function startKeeper(keeper: Wallet, evm: Evm, port = KEEPER_PORT) {
  const fee = formatAmount(KEEPER_FEE.asset, KEEPER_FEE.amount);

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
        const link = evm.txLink(result.hash);
        emit({
          kind: "task.done",
          actor: keeper.name,
          task: invoice,
          message: `${invoice} paid on ${evm.name}: escrow verified the signed rate and sent ${usd(result.payout)} to the supplier, refunded ${usd(result.refund)} to Lena. ${link}`,
          data: { evmTx: result.hash, link, payout: String(result.payout), refund: String(result.refund), rate: checked.display },
        });
        return res.json({ status: "executed", network: evm.name, evmTx: result.hash, link, payout: String(result.payout), refund: String(result.refund), ...condition });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        emit({ kind: "task.failed", actor: keeper.name, task: invoice, message: `${invoice}: execution failed (${reason}); HTTP 502, fee voided` });
        return res.status(502).json({ status: "execution_failed", reason });
      }
    },
  );
  return shop.listen(port);
}

/**
 * After its fee settled, the Keeper publishes a receipt on Cardano (CIP-20):
 * a public track record that links each paid fee to the escrow payment it
 * bought. Costs the Keeper about 0.2 tADA from its earnings.
 */
export async function publishReceipt(keeper: Wallet, evm: Evm, receipt: { invoice: string; orderId: bigint; payee: string; euros: string; rate: string; payout: string; evmTx: string; feeTx: string }) {
  return publish(keeper, [
    `PayOnProof receipt ${receipt.invoice}, order ${receipt.orderId} on ${evm.name}`,
    `Paid ${usd(BigInt(receipt.payout))} to ${receipt.payee}`,
    `= ${receipt.euros} x EUR/USD ${receipt.rate} (API3 Nodary-signed)`,
    `escrow ${evm.escrow}`,
    `escrow tx (${evm.name}):`,
    receipt.evmTx.replace(/^0x/, ""),
    "x402 fee tx (Cardano preprod):",
    receipt.feeTx,
  ], { task: receipt.invoice, title: `a receipt for ${receipt.invoice}` });
}
