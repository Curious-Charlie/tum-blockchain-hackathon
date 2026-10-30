/**
 * The Keepers and their track records, as any buyer can compute them from the
 * chains: receipts on Cardano preprod checked against InvoicePaid on the EVM chain.
 *
 *   npm run keepers -w apps/payonproof                 # addresses, gas, records
 *   npm run keepers -w apps/payonproof -- --fund-eth   # top up each Keeper's EVM gas (0.00003 ETH) from Lena's treasury
 */
import { parseArgs } from "node:util";
import { EXPLORER_TX, Wallet, formatAmount, LOVELACE, TUSDM } from "@agentic/core";
import { createWalletClient, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { connectEvm, lenaKey } from "./evm.ts";
import { KEEPER_ROLES } from "./keeper.ts";
import { keeperRecord, recordText } from "./records.ts";
import { roles } from "./roles.ts";

const { values: args } = parseArgs({ options: { evm: { type: "string" }, "fund-eth": { type: "boolean", default: false }, "eth-per-keeper": { type: "string", default: "0.00003" } } });
const evm = await connectEvm(args.evm, [...KEEPER_ROLES]);
const topUp = parseEther(args["eth-per-keeper"]);
const lena = createWalletClient({ account: privateKeyToAccount(lenaKey()), chain: evm.chain, transport: http(evm.chain.id === 84532 ? (process.env.RPC_URL ?? "https://sepolia.base.org") : undefined) });

try {
  for (const role of KEEPER_ROLES) {
    const wallet = await Wallet.load(role, roles.find((r) => r.role === role)!.name);
    const evmAddress = evm.keeperAddressOf(role);
    const [balance, eth, record] = await Promise.all([wallet.balance(), evm.ethBalance(evmAddress), keeperRecord({ address: wallet.address, evmAddress }, evm)]);
    console.log(`${wallet.name} (${role})`);
    console.log(`  Cardano ${wallet.address}: ${formatAmount(LOVELACE, balance[LOVELACE] ?? 0n)}, ${formatAmount(TUSDM, balance[TUSDM] ?? 0n)}`);
    console.log(`  ${evm.name} ${evmAddress}: ${formatEther(eth)} ETH`);
    console.log(`  record: ${recordText(record)}`);
    for (const d of record.details) console.log(`    ${d.result.padEnd(12)} ${d.invoice.padEnd(8)} ${EXPLORER_TX}${d.receiptTx}${d.why ? `  (${d.why})` : ""}`);
    if (args["fund-eth"] && evm.name === "base-sepolia" && eth < topUp / 2n) {
      const hash = await lena.sendTransaction({ to: evmAddress, value: topUp });
      console.log(`  sent ${args["eth-per-keeper"]} ETH for gas: ${evm.txLink(hash)}`);
    }
  }
} finally {
  evm.close();
}
