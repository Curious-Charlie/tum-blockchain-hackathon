/** Small chain helpers for the demo (Blockfrost, no tight polling). */
import { blockfrost, sleep, type Wallet } from "@agentic/core";

/**
 * Waits until `wallet` has no transaction in the mempool (polls every 5 s, at
 * most `timeoutMs`). A back-to-back rerun would otherwise build a payment from
 * an input the previous run's transaction already spends.
 */
export async function waitUntilIdle(wallet: Wallet, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let said = false;
  while (Date.now() < deadline) {
    const pending = await blockfrost<{ tx_hash: string }[]>(`/mempool/addresses/${wallet.address}`).catch(() => undefined);
    if (!pending?.length) return;
    if (!said) console.log(`  … ${wallet.name}: ${pending.length} transaction(s) from a previous run still in the mempool, waiting`);
    said = true;
    await sleep(5_000);
  }
}
