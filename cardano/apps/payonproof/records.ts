/**
 * A Keeper's track record, computed from public chains only (no ledger of our own):
 *
 * - its receipts on Cardano preprod: CIP-20 records ("PayOnProof receipt …") in
 *   transactions the Keeper's own address signed;
 * - the InvoicePaid events on the EVM chain those receipts point to.
 *
 * A receipt is a verified execution only if that EVM transaction paid the order
 * it names through our escrow contract, executed from the Keeper's EVM account
 * (which the Keeper proves with a signature, see `bindingMessage`). A receipt
 * that does not check out is a false receipt. Receipts of runs on a local test
 * chain cannot be checked and count for nothing.
 *
 * Chain data never changes once confirmed, so every lookup is cached on disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, blockfrost } from "@agentic/core";
import { isAddressEqual, verifyMessage, type Address, type Hex } from "viem";
import type { Evm } from "./evm.ts";

export interface KeeperRecord {
  receipts: number;
  verified: number;
  falseReceipts: number;
  unverifiable: number;
  /** Receipt transaction → what was found. */
  details: { receiptTx: string; invoice: string; network: string; executeTx?: string; result: "verified" | "false" | "unverifiable"; why?: string }[];
}

/** What a Keeper signs with its EVM key to show which Cardano identity it belongs to. */
export const bindingMessage = (cardanoAddress: string, evmAddress: string) => `PayOnProof keeper ${cardanoAddress} executes from ${evmAddress.toLowerCase()}`;

export async function verifyBinding(cardanoAddress: string, evmAddress: Address, signature: Hex): Promise<boolean> {
  return verifyMessage({ address: evmAddress, message: bindingMessage(cardanoAddress, evmAddress), signature }).catch(() => false);
}

const CACHE = path.join(ROOT, ".cache", "chain");

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const file = path.join(CACHE, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  const value = await load();
  if (value === null || value === undefined) return value; // "not found" may be a lagging node: ask again next time
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return value;
}

interface Receipt {
  tx: string;
  lines: string[];
}

/** The Keeper's CIP-20 receipts: label 674 records in transactions it signed. */
export async function receiptsOf(cardanoAddress: string): Promise<Receipt[]> {
  const txs = (await blockfrost<{ tx_hash: string }[]>(`/addresses/${cardanoAddress}/transactions?order=desc&count=100`)) ?? [];
  const receipts: Receipt[] = [];
  for (const { tx_hash: tx } of txs) {
    const metadata = await cached(`cardano-metadata-${tx}`, async () => (await blockfrost<{ label: string; json_metadata: { msg?: string[] } }[]>(`/txs/${tx}/metadata`)) ?? []);
    const lines = metadata.find((m) => m.label === "674")?.json_metadata.msg;
    if (!lines?.[0]?.startsWith("PayOnProof receipt")) continue;
    const utxos = await cached(`cardano-utxos-${tx}`, async () => (await blockfrost<{ inputs: { address: string }[] }>(`/txs/${tx}/utxos`)) ?? { inputs: [] });
    if (!utxos.inputs.length || !utxos.inputs.every((i) => i.address === cardanoAddress)) continue; // not signed by this Keeper
    receipts.push({ tx, lines });
  }
  return receipts;
}

/** Pulls the order, network and EVM transaction out of a receipt's lines. */
export function parseReceipt(lines: string[]): { invoice: string; orderId?: bigint; network?: string; executeTx?: Hex } {
  const head = lines[0]!.match(/^PayOnProof receipt (\S+), order (\d+) on (\S+)$/);
  const at = lines.findIndex((l) => /^escrow tx \(.+\):$/.test(l));
  const hash = at >= 0 ? lines[at + 1] : undefined;
  return {
    invoice: head?.[1] ?? "?",
    orderId: head ? BigInt(head[2]!) : undefined,
    network: head?.[3],
    executeTx: hash && /^[0-9a-f]{64}$/.test(hash) ? (`0x${hash}` as Hex) : undefined,
  };
}

export async function keeperRecord(keeper: { address: string; evmAddress?: Address }, evm: Evm): Promise<KeeperRecord> {
  const record: KeeperRecord = { receipts: 0, verified: 0, falseReceipts: 0, unverifiable: 0, details: [] };
  for (const receipt of await receiptsOf(keeper.address)) {
    record.receipts++;
    const { invoice, orderId, network, executeTx } = parseReceipt(receipt.lines);
    const detail = { receiptTx: receipt.tx, invoice, network: network ?? "?", executeTx };
    if (network !== evm.name) {
      record.unverifiable++;
      record.details.push({ ...detail, result: "unverifiable", why: `run on ${network}, not ${evm.name}` });
      continue;
    }
    const paid = executeTx ? await cached(`${evm.name}-paid-${executeTx}`, () => evm.invoicePaidIn(executeTx)) : null;
    const why = !executeTx ? "names no EVM transaction"
      : !paid ? `${executeTx.slice(0, 10)}… paid no order through the escrow`
      : BigInt(paid.orderId) !== orderId ? `${executeTx.slice(0, 10)}… paid order ${paid.orderId}, not ${orderId}`
      : !keeper.evmAddress || !isAddressEqual(paid.executor as Address, keeper.evmAddress) ? `${executeTx.slice(0, 10)}… was executed by ${String(paid.executor).slice(0, 10)}…, not this Keeper`
      : undefined;
    if (why) record.falseReceipts++;
    else record.verified++;
    record.details.push({ ...detail, result: why ? "false" : "verified", why });
  }
  return record;
}

export const recordText = (r: KeeperRecord) =>
  `${r.verified} verified execution${r.verified === 1 ? "" : "s"} on chain (${r.receipts} receipt${r.receipts === 1 ? "" : "s"} on Cardano${r.falseReceipts ? `, ${r.falseReceipts} false` : ""}${r.unverifiable ? `, ${r.unverifiable} from a test chain` : ""})`;
