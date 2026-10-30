/**
 * guard.fetch with one workaround: right after a wallet's previous transaction
 * confirms, Blockfrost's UTxO view can lag, so the buyer may sign a payment
 * that spends an already-spent UTxO and the seller's facilitator rejects it
 * (HTTP 402, nothing is paid). Waiting 15 s and paying again fixes it.
 */
import { emit, sleep, type AgentGuard } from "@agentic/core";

/** The seller's reason from an x402 PAYMENT-REQUIRED header (base64 JSON). */
export function paymentError(response: Response): string | undefined {
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return undefined;
  try {
    return (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { error?: string }).error;
  } catch {
    return undefined;
  }
}

export async function paidFetch(guard: AgentGuard, url: string, init: RequestInit, meta: { task: string; purpose: string }, retries = 2): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await guard.fetch(url, init, meta);
    if (response.status !== 402 || attempt >= retries) return response;
    const reason = paymentError(response) ?? "payment rejected";
    console.warn(`  ! ${guard.name}: seller rejected the signed payment (${reason}); retrying in 15 s`);
    emit({ kind: "task.step", actor: guard.name, task: meta.task, message: `Seller rejected the signed payment (${reason}), typically a stale UTxO view right after the previous transaction. Paying again in 15 s` });
    await sleep(15_000);
  }
}
