/**
 * Deploys the PayOnProof contracts to Base Sepolia (reusing what
 * deployments.json already lists) and gives the Keeper's EVM account gas.
 *
 *   npm run deploy -w apps/payonproof              # from cardano/
 *   npm run deploy -w apps/payonproof -- --dry-run # cost estimate only
 *
 * Base Sepolia charges an L1 data fee per byte, so deploying the escrow
 * (~9.6 KB) costs far more than calling it.
 */
import { parseArgs } from "node:util";
import { concatHex, createPublicClient, createWalletClient, encodeAbiParameters, formatEther, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { EUR_USD_REQUEST_HASH, bytecode, keeperKey, lenaKey, writeDeployment } from "./evm.ts";
import deployments from "./deployments.json" with { type: "json" };

const { values: args } = parseArgs({ options: { "dry-run": { type: "boolean", default: false }, "keeper-eth": { type: "string", default: "0.00003" }, margin: { type: "string", default: "30" } } });
const MAX_RATE_AGE = 3n * 24n * 3600n; // FX closes for the weekend
const transport = http(process.env.RPC_URL ?? "https://sepolia.base.org");
const client = createPublicClient({ chain: baseSepolia, transport });
const lena = createWalletClient({ account: privateKeyToAccount(lenaKey()), chain: baseSepolia, transport });
const keeper = privateKeyToAccount(keeperKey()).address;
const oracle = { address: "0x420000000000000000000000000000000000000F" as Address, abi: parseAbi(["function getL1Fee(bytes) view returns (uint256)"]) };
const existing = (deployments as Record<string, { usd?: Address; escrow?: Address }>)["base-sepolia"] ?? {};

const plan: { name: string; data: Hex }[] = [];
if (!existing.usd) plan.push({ name: "DemoUSD", data: bytecode("DemoUSD") });
plan.push({ name: "InvoiceEscrow", data: concatHex([bytecode("InvoiceEscrow"), encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [EUR_USD_REQUEST_HASH, MAX_RATE_AGE])]) });

const gasPrice = await client.getGasPrice();
let total = 0n;
for (const step of plan) {
  const l1 = await client.readContract({ ...oracle, functionName: "getL1Fee", args: [step.data] });
  const l2 = (await client.estimateGas({ account: lena.account, data: step.data })) * gasPrice;
  total += l1 + l2;
  console.log(`${step.name}: ~${formatEther(l1 + l2)} ETH (L1 data ${formatEther(l1)})`);
}
const keeperEth = parseEther(args["keeper-eth"]);
const keeperBalance = await client.getBalance({ address: keeper });
const topUp = keeperBalance < keeperEth / 2n ? keeperEth : 0n;
const balance = await client.getBalance({ address: lena.account.address });
const needed = (total * (100n + BigInt(args.margin))) / 100n + topUp;
console.log(`Needs ~${formatEther(needed)} ETH incl. ${args.margin}% margin and ${formatEther(topUp)} ETH for the Keeper; ${lena.account.address} has ${formatEther(balance)} ETH`);
if (args["dry-run"]) process.exit(0);
if (balance < needed) {
  console.error(`Not enough Base Sepolia ETH: get ~${formatEther(needed - balance)} more for ${lena.account.address} (e.g. the Coinbase CDP faucet).`);
  process.exit(1);
}

for (const step of plan) {
  const hash = await lena.sendTransaction({ data: step.data }).catch((error: Error & { shortMessage?: string; details?: string }) => {
    console.error(`${step.name}: ${error.shortMessage ?? error.message} ${error.details ?? ""}`);
    process.exit(1);
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${step.name} deployment failed: ${hash}`);
  writeDeployment("base-sepolia", step.name === "DemoUSD" ? { usd: receipt.contractAddress } : { escrow: receipt.contractAddress });
  console.log(`${step.name} at https://sepolia.basescan.org/address/${receipt.contractAddress} (tx ${hash})`);
}
if (topUp) {
  const hash = await lena.sendTransaction({ to: keeper, value: topUp });
  await client.waitForTransactionReceipt({ hash });
  console.log(`Sent ${formatEther(topUp)} ETH to the Keeper's EVM account ${keeper} (tx ${hash})`);
}
console.log("Done. `npm run demo -w apps/payonproof` now uses Base Sepolia.");
