/** Small chain helpers for the demo (Blockfrost, no tight polling). */
import { blockfrost, sleep, type Wallet } from "@agentic/core";
import { INDEX_LAG_MS } from "./config.ts";

/**
 * Waits until `wallet` has no transaction in the mempool (polls every 5 s, at
 * most `timeoutMs`), then until its latest transaction is at least
 * INDEX_LAG_MS old. A back-to-back rerun would otherwise build a payment from
 * an input the previous run already spent, or that Blockfrost has not indexed.
 */
export async function waitUntilIdle(wallet: Wallet, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let said = false;
  while (Date.now() < deadline) {
    const pending = await blockfrost<{ tx_hash: string }[]>(`/mempool/addresses/${wallet.address}`).catch(() => undefined);
    if (!pending?.length) break;
    if (!said) console.log(`  … ${wallet.name}: ${pending.length} transaction(s) from a previous run still in the mempool, waiting`);
    said = true;
    await sleep(5_000);
  }
  const [latest] = (await blockfrost<{ block_time: number }[]>(`/addresses/${wallet.address}/transactions?order=desc&count=1`).catch(() => undefined)) ?? [];
  const age = latest ? Date.now() - latest.block_time * 1000 : Infinity;
  if (age < INDEX_LAG_MS) await sleep(INDEX_LAG_MS - age);
}
