/**
 * The Replicator as a buyer: ask several compute agents for a price, judge
 * which one is worth paying, and pay only that one (through AgentGuard).
 *
 * - The price comes from each agent's x402 402 answer to the real request, so
 *   the quote is exactly what it would charge.
 * - The track record is the Replicator's own ledger: runs bought from each
 *   agent and how many passed the Verifier (lib/reputation.ts).
 * - The choice is deterministic code: the quote must pay the agent we asked,
 *   fit AgentGuard's per-payment cap and leave enough task budget for the
 *   Verifier, and the agent needs a verified rate of at least 80 % over at least
 *   5 runs; the cheapest such quote wins (ties: better record).
 */
import { formatAmount } from "@agentic/core";

export interface Provider {
  /** Wallet role, the key of its track record (e.g. COMPUTE_B). */
  role: string;
  name: string;
  url: string;
  address: string;
}

export interface Quote extends Provider {
  asset: string;
  amount: bigint;
  payTo: string;
}

export interface TrackRecord {
  runs: number;
  verified: number;
}

export interface Budget {
  asset: string;
  /** AgentGuard's per-payment cap. */
  maxPerPayment: bigint;
  /** What the task budget can still spend on compute (the Verifier's fee is kept aside). */
  availableForCompute: bigint;
}

export interface Assessment {
  name: string;
  price: string;
  record: string;
  chosen: boolean;
  why: string;
}

export const MIN_VERIFIED_RATE = 0.8;
export const MIN_RUNS = 5;

const recordText = (r?: TrackRecord) => (r && r.runs ? `${r.verified}/${r.runs} runs verified` : "no track record");
const rate = (r?: TrackRecord) => (r && r.runs ? r.verified / r.runs : 0);

export function chooseProvider(quotes: Quote[], records: Record<string, TrackRecord>, budget: Budget): { chosen?: Quote; assessments: Assessment[] } {
  const reject = (quote: Quote): string | undefined => {
    const record = records[quote.role];
    if (quote.payTo !== quote.address) return "its quote pays a different address than the agent we asked";
    if (quote.asset !== budget.asset) return `it charges in another asset (${quote.asset.slice(0, 10)}…)`;
    if (quote.amount > budget.maxPerPayment) return `over AgentGuard's per-payment cap of ${formatAmount(budget.asset, budget.maxPerPayment)}`;
    if (quote.amount > budget.availableForCompute) return `would leave too little task budget for the Verifier (${formatAmount(budget.asset, budget.availableForCompute)} available for compute)`;
    if (!record || record.runs < MIN_RUNS) return `too little track record (needs ${MIN_RUNS} runs)`;
    if (rate(record) < MIN_VERIFIED_RATE) return `only ${Math.round(rate(record) * 100)} % of its runs passed verification (needs ${MIN_VERIFIED_RATE * 100} %)`;
    return undefined;
  };
  const eligible = quotes
    .filter((q) => !reject(q))
    .sort((a, b) => (a.amount === b.amount ? rate(records[b.role]) - rate(records[a.role]) : a.amount < b.amount ? -1 : 1));
  const chosen = eligible[0];
  const assessments = quotes.map((q) => {
    const reason = reject(q);
    const isChosen = q === chosen;
    return {
      name: q.name,
      price: formatAmount(q.asset, q.amount),
      record: recordText(records[q.role]),
      chosen: isChosen,
      why: reason ?? (isChosen ? "cheapest provider within budget with a good track record" : `${formatAmount(chosen!.asset, chosen!.amount)} from ${chosen!.name} is cheaper or better proven`),
    };
  });
  return { chosen, assessments };
}

/** Asks for a price: the unpaid request returns 402 with the x402 payment requirements. */
export async function getQuote(provider: Provider, path: string, body: unknown): Promise<Quote | undefined> {
  const response = await fetch(`${provider.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (response.status !== 402 || !header) return undefined;
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts: { asset: string; amount: string; payTo: string }[] };
  const offer = required.accepts[0];
  return offer ? { ...provider, asset: offer.asset, amount: BigInt(offer.amount), payTo: offer.payTo } : undefined;
}
