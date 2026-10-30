/**
 * Publishes a record on Cardano as CIP-20 transaction metadata (label 674,
 * `{ msg: [line, ...] }`, each line at most 64 bytes). Anyone can read it on
 * cardanoscan under the transaction's "Metadata" tab.
 */
import { Address, Assets, TransactionMetadatum } from "@evolution-sdk/evolution";
import { EXPLORER_TX } from "./config.ts";
import { emit } from "./events.ts";
import type { Wallet } from "./wallets.ts";

const MAX_BYTES = 64;

/** Splits text into CIP-20 lines of at most 64 UTF-8 bytes, never inside a character. */
export function cip20Lines(texts: string[]): string[] {
  const lines: string[] = [];
  for (const text of texts) {
    let line = "";
    for (const char of text) {
      if (Buffer.byteLength(line + char) > MAX_BYTES) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
    lines.push(line);
  }
  return lines;
}

export interface Published {
  tx: string;
  url: string;
  lines: string[];
}

/** Sends a small self-payment carrying the record. Returns once the tx is submitted. */
export async function publish(wallet: Wallet, texts: string[], meta: { task?: string; title?: string } = {}): Promise<Published> {
  const lines = cip20Lines(texts);
  const tx = await wallet.transact((builder) =>
    builder
      .payToAddress({ address: Address.fromBech32(wallet.address), assets: Assets.fromLovelace(1_500_000n) })
      .attachMetadata({ label: 674n, metadata: TransactionMetadatum.fromEntries([["msg", lines]]) }),
  );
  emit({ kind: "chain.published", actor: wallet.name, task: meta.task, tx, message: `${wallet.name} published ${meta.title ?? "a record"} on Cardano (CIP-20)`, data: { lines } });
  return { tx, url: `${EXPLORER_TX}${tx}`, lines };
}
