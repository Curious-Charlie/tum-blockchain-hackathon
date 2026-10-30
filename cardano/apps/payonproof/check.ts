/**
 * Anyone can check a Keeper's receipt against both chains:
 *
 *   npm run check -w apps/payonproof -- <receipt tx hash on Cardano preprod>
 *
 * Reads the CIP-20 receipt, rebuilds the execution proof from the EVM chain
 * (the execute transaction and its InvoicePaid event), hashes it and compares
 * the hash with the receipt and with the result hash stored in the Masumi
 * escrow datum. For receipts of per-attempt (x402) jobs it checks the payment.
 */
import { Data } from "@evolution-sdk/evolution";
import { parseMasumiLockDatum } from "@x402/cardano";
import { EXPLORER_TX, blockfrost } from "@agentic/core";
import { ESCROW_ADDRESS } from "@agentic/core/escrow";
import { connectEvm, usd } from "./evm.ts";
import { proofFromChain, proofHash } from "./proof.ts";
import { parseReceipt } from "./records.ts";

const tx = process.argv[2];
if (!tx || !/^[0-9a-f]{64}$/.test(tx)) {
  console.error("usage: npm run check -w apps/payonproof -- <receipt tx hash>");
  process.exit(2);
}

const metadata = await blockfrost<{ label: string; json_metadata: { msg?: string[] } }[]>(`/txs/${tx}/metadata`);
const lines = metadata?.find((m) => m.label === "674")?.json_metadata.msg;
if (!lines?.[0]?.startsWith("PayOnProof receipt")) {
  console.error(`No PayOnProof receipt in ${tx} (not confirmed yet, or not a receipt).`);
  process.exit(1);
}
console.log(`Receipt on Cardano preprod: ${EXPLORER_TX}${tx}\n${lines.map((l) => `  | ${l}`).join("\n")}\n`);

const after = (label: string) => lines[lines.indexOf(label) + 1];
const { orderId, network, executeTx } = parseReceipt(lines);
const evm = await connectEvm(network === "anvil" ? "anvil" : "base-sepolia");
let ok = true;
const show = (pass: boolean, text: string) => {
  ok &&= pass;
  console.log(`${pass ? "✓" : "✗"} ${text}`);
};

try {
  if (network !== evm.name || !executeTx) throw new Error(`the receipt is for ${network}; only ${evm.name} receipts can be checked here`);
  const paid = await evm.invoicePaidIn(executeTx);
  show(Boolean(paid), `${evm.txLink(executeTx)} emitted InvoicePaid from the escrow ${evm.escrow}`);
  if (paid) {
    show(paid.orderId === orderId, `it paid order ${paid.orderId} (receipt: order ${orderId}), ${usd(paid.payout)} at EUR/USD ${(Number(paid.rate) / 1e18).toFixed(5)}, executed by ${paid.executor}`);
  }
  const lockTx = after("fee locked in Masumi escrow, lock tx:");
  if (!lockTx) {
    console.log(`  per-attempt (x402) receipt: fee ${EXPLORER_TX}${after("x402 fee tx (Cardano preprod):")}`);
  } else {
    const claimed = after("result hash (sha256 of the execution proof):");
    const resultTx = after("result submitted in tx:")!;
    const proof = await proofFromChain(evm, executeTx, lockTx);
    const rebuilt = proof ? proofHash(proof) : undefined;
    show(rebuilt === claimed, `the execution proof rebuilt from ${evm.name} hashes to the receipt's result hash ${claimed?.slice(0, 16)}…`);
    const outputs = await blockfrost<{ outputs: { address: string; inline_datum: string | null }[] }>(`/txs/${resultTx}/utxos`);
    const datum = outputs?.outputs.find((o) => o.address === ESCROW_ADDRESS && o.inline_datum)?.inline_datum;
    const view = datum ? parseMasumiLockDatum(Data.fromCBORHex(datum)) : undefined;
    show(view?.resultHash === claimed, `the Masumi escrow datum in ${EXPLORER_TX}${resultTx} holds the same result hash`);
    show(Boolean(view && lockTx), `the fee was locked in ${EXPLORER_TX}${lockTx}`);
  }
} catch (error) {
  show(false, error instanceof Error ? error.message : String(error));
} finally {
  evm.close();
}
console.log(ok ? "\nReceipt checks out on both chains." : "\nReceipt does NOT check out.");
process.exit(ok ? 0 : 1);
