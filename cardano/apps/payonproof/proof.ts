/**
 * The execution proof behind a Keeper's result hash in the Masumi escrow.
 *
 * The result hash is sha256 of this record as canonical JSON (sorted keys). It
 * binds the escrowed fee (the Cardano lock transaction) to the payment it
 * bought: the `execute` transaction on the EVM chain and the InvoicePaid event
 * our escrow contract emitted in it. Anyone can rebuild the record from the two
 * chains and compare hashes: `npm run check -w apps/payonproof -- <receipt tx>`.
 */
import { createHash } from "node:crypto";
import type { Hex } from "viem";
import type { Evm } from "./evm.ts";

export interface ExecutionProof {
  schema: "payonproof/execution@1";
  /** Cardano preprod transaction that locked the Keeper's fee in Masumi escrow. */
  feeLockTx: string;
  chainId: number;
  invoiceEscrow: string;
  executeTx: string;
  block: string;
  /** InvoicePaid(orderId, executor, rate, rateTimestamp, payout, refund) as emitted. */
  invoicePaid: { orderId: string; executor: string; rate: string; rateTimestamp: string; payout: string; refund: string };
}

export const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

/** JSON with sorted keys, so the hash does not depend on key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((k) => record[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const proofHash = (proof: ExecutionProof) => sha256(canonical(proof));

/** Rebuilds the proof from the EVM chain; undefined if `executeTx` paid no order through our escrow. */
export async function proofFromChain(evm: Evm, executeTx: Hex, feeLockTx: string): Promise<ExecutionProof | undefined> {
  const paid = await evm.invoicePaidIn(executeTx);
  if (!paid) return undefined;
  return {
    schema: "payonproof/execution@1",
    feeLockTx,
    chainId: evm.chain.id,
    invoiceEscrow: evm.escrow.toLowerCase(),
    executeTx: executeTx.toLowerCase(),
    block: String(paid.blockNumber),
    invoicePaid: {
      orderId: String(paid.orderId),
      executor: paid.executor.toLowerCase(),
      rate: String(paid.rate),
      rateTimestamp: String(paid.rateTimestamp),
      payout: String(paid.payout),
      refund: String(paid.refund),
    },
  };
}
