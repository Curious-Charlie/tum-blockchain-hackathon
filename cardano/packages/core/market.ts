/**
 * An agent buying a service from several sellers: ask each for a price, judge
 * the quotes in code, pay only the chosen one (`payOffer` signs nothing else).
 *
 * - The price is each seller's x402 402 answer to the real request, so the
 *   quote is exactly what it would charge; for an escrow route the quote also
 *   names the seller in the Masumi terms.
 * - `choose` is deterministic: the quote must pay the agent we asked (or lock
 *   into Masumi's escrow for that agent), in the expected asset, within the limit;
 *   the app's own check (e.g. a track record) decides the rest; cheapest wins.
 *
 *   const quotes = await Promise.all(sellers.map((s) => getQuote(s, "/work", body)));
 *   const { chosen, assessments } = choose(quotes, { asset: TUSDM, maxAmount, check, record });
 */
import { masumiEscrowAddress } from "@x402/cardano";
import { NETWORK, formatAmount } from "./config.ts";

export interface Provider {
  /** Wallet role, e.g. KEEPER_B. */
  role: string;
  name: string;
  url: string;
  /** The seller's Cardano address. */
  address: string;
}

export interface Quote extends Provider {
  asset: string;
  amount: bigint;
  payTo: string;
  /** Paid into Masumi escrow instead of to the seller. */
  escrow: boolean;
  /** Who gets the money: `payTo`, or for escrow the seller named in the signed terms. */
  payee?: string;
}

export interface Assessment {
  role: string;
  name: string;
  price: string;
  record: string;
  chosen: boolean;
  why: string;
}

/** Asks for a price: the unpaid request returns 402 with the x402 payment requirements. */
export async function getQuote(provider: Provider, path: string, body: unknown): Promise<Quote | undefined> {
  const response = await fetch(`${provider.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (response.status !== 402 || !header) return undefined;
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepts: { asset: string; amount: string; payTo: string; extra?: { assetTransferMethod?: string; terms?: { sellerAddress?: string } } }[];
  };
  const offer = required.accepts[0];
  if (!offer) return undefined;
  const escrow = offer.extra?.assetTransferMethod === "masumi";
  return { ...provider, asset: offer.asset, amount: BigInt(offer.amount), payTo: offer.payTo, escrow, payee: escrow ? offer.extra?.terms?.sellerAddress : offer.payTo };
}

/** Transaction hash from an x402 PAYMENT-RESPONSE header (base64 JSON), if it settled. */
export function settlementTx(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  try {
    const settlement = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { success?: boolean; transaction?: string };
    return settlement.success ? settlement.transaction : undefined;
  } catch {
    return undefined;
  }
}

export function choose(
  quotes: (Quote | undefined)[],
  rules: {
    asset: string;
    /** Most the buyer pays for this service. */
    maxAmount: bigint;
    /** The app's own reasons to refuse a seller (undefined = acceptable). */
    check?: (quote: Quote) => string | undefined;
    /** One line about the seller's track record, for the explanation. */
    record?: (quote: Quote) => string;
    /** Tie-break between equal prices (negative: a first). */
    rank?: (a: Quote, b: Quote) => number;
  },
): { chosen?: Quote; assessments: Assessment[] } {
  const offered = quotes.filter((q): q is Quote => Boolean(q));
  const reject = (q: Quote): string | undefined => {
    if (q.payee !== q.address) return "its quote pays a different address than the agent we asked";
    if (q.escrow && q.payTo !== masumiEscrowAddress(NETWORK)) return "its escrow address is not Masumi's";
    if (q.asset !== rules.asset) return `it charges in another asset (${q.asset.slice(0, 10)}…)`;
    if (q.amount > rules.maxAmount) return `over the fee limit of ${formatAmount(rules.asset, rules.maxAmount)}`;
    return rules.check?.(q);
  };
  const eligible = offered
    .filter((q) => !reject(q))
    .sort((a, b) => (a.amount === b.amount ? (rules.rank?.(a, b) ?? 0) : a.amount < b.amount ? -1 : 1));
  const chosen = eligible[0];
  const assessments = offered.map((q) => {
    const reason = reject(q);
    return {
      role: q.role,
      name: q.name,
      price: formatAmount(q.asset, q.amount),
      record: rules.record?.(q) ?? "",
      chosen: q === chosen,
      why: reason ?? (q === chosen ? "cheapest acceptable offer" : `${formatAmount(chosen!.asset, chosen!.amount)} from ${chosen!.name} is cheaper or better proven`),
    };
  });
  return { chosen, assessments };
}
