/**
 * The Keepers and their track records, as any buyer can compute them from the
 * chains: receipts on Cardano preprod checked against InvoicePaid on the EVM chain.
 *
 *   npm run keepers -w apps/payonproof                 # addresses, gas, records
 *   npm run keepers -w apps/payonproof -- --fund-eth   # top up each Keeper's EVM gas (0.00003 ETH) from Lena's treasury
 *   npm run keepers -w apps/payonproof -- --fund-ausd  # each Keeper mints 1 aUSD at AirnodeHub's faucet (pays for the second rate)
 *   npm run keepers -w apps/payonproof -- --consolidate  # merge small Cardano UTxOs (script transactions need one ≥ 5 tADA collateral)
 */
import { parseArgs } from "node:util";
import { EXPLORER_TX, Wallet, ada, blockfrost, formatAmount, LOVELACE, TUSDM } from "@agentic/core";
import { createPublicClient, createWalletClient, formatEther, formatUnits, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AUSD } from "./crosscheck.ts";
import { connectEvm, keeperKey, lenaKey } from "./evm.ts";
import { KEEPER_ROLES } from "./keeper.ts";
import { keeperRecord, recordText } from "./records.ts";
import { roles } from "./roles.ts";

const { values: args } = parseArgs({ options: { evm: { type: "string" }, "fund-eth": { type: "boolean", default: false }, "fund-ausd": { type: "boolean", default: false }, consolidate: { type: "boolean", default: false }, "eth-per-keeper": { type: "string", default: "0.00003" } } });
const ausdAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function mintFromFaucet(uint256 amount)"]);
const evm = await connectEvm(args.evm, [...KEEPER_ROLES]);
const topUp = parseEther(args["eth-per-keeper"]);
const transport = http(evm.chain.id === 84532 ? (process.env.RPC_URL ?? "https://sepolia.base.org") : undefined);
const lena = createWalletClient({ account: privateKeyToAccount(lenaKey()), chain: evm.chain, transport });
const reader = createPublicClient({ chain: evm.chain, transport });

try {
  for (const role of KEEPER_ROLES) {
    const wallet = await Wallet.load(role, roles.find((r) => r.role === role)!.name);
    const evmAddress = evm.keeperAddressOf(role);
    const [balance, eth, record] = await Promise.all([wallet.balance(), evm.ethBalance(evmAddress), keeperRecord({ address: wallet.address, evmAddress }, evm)]);
    console.log(`${wallet.name} (${role})`);
    console.log(`  Cardano ${wallet.address}: ${formatAmount(LOVELACE, balance[LOVELACE] ?? 0n)}, ${formatAmount(TUSDM, balance[TUSDM] ?? 0n)}`);
    const ausd = evm.name === "base-sepolia" ? await reader.readContract({ address: AUSD, abi: ausdAbi, functionName: "balanceOf", args: [evmAddress] }) : 0n;
    console.log(`  ${evm.name} ${evmAddress}: ${formatEther(eth)} ETH, ${formatUnits(ausd, 6)} aUSD`);
    console.log(`  record: ${recordText(record)}`);
    for (const d of record.details) console.log(`    ${d.result.padEnd(12)} ${d.invoice.padEnd(8)} ${EXPLORER_TX}${d.receiptTx}${d.why ? `  (${d.why})` : ""}`);
    if (args["fund-eth"] && evm.name === "base-sepolia" && eth < topUp / 2n) {
      const hash = await lena.sendTransaction({ to: evmAddress, value: topUp });
      console.log(`  sent ${args["eth-per-keeper"]} ETH for gas: ${evm.txLink(hash)}`);
    }
    if (args.consolidate) {
      // evolution-sdk takes collateral from the largest pure-ADA UTxOs (5 tADA); many small ones can leave a change below the minimum.
      const utxos = (await blockfrost<{ amount: { unit: string; quantity: string }[] }[]>(`/addresses/${wallet.address}/utxos`)) ?? [];
      const pure = utxos.filter((u) => u.amount.length === 1).map((u) => Number(u.amount[0]!.quantity) / 1e6);
      const total = pure.reduce((a, b) => a + b, 0);
      if (Math.max(0, ...pure) < 8 && total > 10) {
        const tx = await wallet.send([{ address: wallet.address, amounts: [ada(Math.floor(total - 2))] }]);
        console.log(`  merged ${pure.length} small UTxOs into one of ${Math.floor(total - 2)} tADA: ${EXPLORER_TX}${tx}`);
      }
    }
    if (args["fund-ausd"] && evm.name === "base-sepolia" && ausd < 100_000n) {
      const keeper = createWalletClient({ account: privateKeyToAccount(keeperKey(role)), chain: evm.chain, transport });
      const hash = await keeper.writeContract({ address: AUSD, abi: ausdAbi, functionName: "mintFromFaucet", args: [1_000_000n] });
      await reader.waitForTransactionReceipt({ hash });
      console.log(`  minted 1 aUSD at AirnodeHub's faucet: ${evm.txLink(hash)}`);
    }
  }
} finally {
  evm.close();
}
