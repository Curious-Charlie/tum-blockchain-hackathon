/**
 * How our agents pay: only the offer they accepted. `payOffer(wallet, offer, url)`
 * replaces `fetch`; on HTTP 402 it signs only if the payment request is that
 * offer: the same seller (for a Masumi escrow lock, the seller named in the
 * signed terms, and the escrow must be Masumi's), the same asset and at most
 * the agreed amount. Anything else is refused before signing.
 *
 * A response >= 400 means the seller voided the payment (its work failed, so
 * x402 never submits the transaction). If the seller rejects the signed payment
 * itself (402 after paying, usually a lagging chain view), nothing was paid and
 * the request is retried once after 15 s.
 */
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { masumiEscrowAddress } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { NETWORK, formatAmount, fromUnit, shortAddress, sleep } from "./config.ts";
import { emit } from "./events.ts";
import type { Wallet } from "./wallets.ts";

/** What the buyer agreed to pay, and to whom. A market `Quote` is one. */
export interface Offer {
  /** The seller's display name and Cardano address. */
  name: string;
  address: string;
  asset: string;
  /** The most the buyer pays. */
  amount: bigint;
}

/** The x402 payment requirements the seller sent with its 402. */
export interface PaymentRequest {
  payTo: string;
  asset: string;
  amount: string;
  extra?: Record<string, unknown>;
}

/** Dashboard name of Masumi's escrow contract. */
export const ESCROW = "Masumi escrow";

export class PaymentRefused extends Error {
  constructor(readonly reason: string) {
    super(`Refused to sign: ${reason}`);
    this.name = "PaymentRefused";
  }
}

/** Why a payment request is not the accepted offer, or undefined if it is. Pure, so it can be unit tested. */
export function mismatch(offer: Offer, req: PaymentRequest): string | undefined {
  const escrow = req.extra?.assetTransferMethod === "masumi";
  const seller = escrow ? (req.extra as { terms?: { sellerAddress?: string } }).terms?.sellerAddress : req.payTo;
  if (escrow && req.payTo !== masumiEscrowAddress(NETWORK)) return `${shortAddress(req.payTo)} is not Masumi's escrow contract`;
  if (seller !== offer.address) return `it pays ${seller ? shortAddress(seller) : "an unnamed seller"}, not ${offer.name}`;
  if (fromUnit(req.asset) !== fromUnit(offer.asset)) return "it asks for another asset than agreed";
  if (BigInt(req.amount) > offer.amount) {
    return `it asks ${formatAmount(req.asset, req.amount)}, more than the agreed ${formatAmount(offer.asset, offer.amount)}`;
  }
  return undefined;
}

/** `fetch` that pays an x402 request only if it is the accepted offer. Throws `PaymentRefused` otherwise. */
export async function payOffer(wallet: Wallet, offer: Offer, input: string | URL, init: RequestInit = {}, meta: { task?: string; purpose?: string } = {}): Promise<Response> {
  return wallet.exclusive(async () => {
    const first = await attempt(wallet, offer, input, init, meta);
    if (!first.retry) return first.response;
    // Usually Blockfrost still lists a UTxO our previous transaction just spent. Nothing was paid.
    emit({ kind: "task.step", actor: wallet.name, task: meta.task, message: "Seller rejected the signed payment (chain view lagging); nothing paid, retrying in 15 s" });
    await sleep(15_000);
    return (await attempt(wallet, offer, input, init, meta)).response;
  });
}

async function attempt(wallet: Wallet, offer: Offer, input: string | URL, init: RequestInit, meta: { task?: string; purpose?: string }): Promise<{ response: Response; retry: boolean }> {
  const { task, purpose } = meta;
  let refused: string | undefined;
  let signed: { escrow: boolean; amount: string } | undefined;

  const client = x402Client.fromConfig({
    schemes: [{ network: NETWORK, client: new ExactCardanoScheme(wallet.signer()) }],
    spendControls: { allowedAssets: [{ network: NETWORK, asset: fromUnit(offer.asset) }] },
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
    refused = mismatch(offer, req);
    if (refused) return { abort: true, reason: refused };
    const escrow = req.extra?.assetTransferMethod === "masumi";
    const amount = formatAmount(req.asset, req.amount);
    signed = { escrow, amount };
    emit({ kind: "payment.signed", actor: wallet.name, task, from: wallet.name, to: escrow ? ESCROW : offer.name, amount, message: `${wallet.name} signed ${escrow ? `a ${amount} lock in Masumi escrow for ${offer.name}` : `${amount} → ${offer.name}`}${purpose ? ` for ${purpose}` : ""}` });
  });

  let response: Response;
  try {
    response = await wrapFetchWithPayment(fetch, client)(input, init);
  } catch (error) {
    if (refused) {
      emit({ kind: "task.step", actor: wallet.name, task, message: `Refused to sign: ${offer.name}'s payment request is not the accepted offer (${refused})` });
      throw new PaymentRefused(refused);
    }
    throw error;
  }
  if (!signed) return { response, retry: false };

  const { escrow, amount } = signed;
  const header = response.headers.get("PAYMENT-RESPONSE");
  const settlement = header ? decodePaymentResponseHeader(header) : undefined;
  if (response.ok && settlement?.success && settlement.transaction) {
    wallet.submitted(settlement.transaction);
    emit(escrow
      ? { kind: "payment.settled", actor: wallet.name, task, from: wallet.name, to: ESCROW, amount, tx: settlement.transaction, message: `${wallet.name} locked ${amount} in Masumi escrow for ${offer.name}`, data: { escrow: true, seller: offer.name } }
      : { kind: "payment.settled", actor: wallet.name, task, from: wallet.name, to: offer.name, amount, tx: settlement.transaction, message: `${wallet.name} paid ${amount} → ${offer.name}` });
    return { response, retry: false };
  }
  if (response.status === 402) return { response, retry: true };
  emit({ kind: "payment.voided", actor: wallet.name, task, from: wallet.name, to: offer.name, amount, message: `${offer.name} answered HTTP ${response.status}: the signed ${amount} was never submitted, nothing paid`, data: { status: response.status } });
  return { response, retry: false };
}
