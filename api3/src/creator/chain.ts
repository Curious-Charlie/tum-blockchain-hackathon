// Base Sepolia clients, the CreatorDealEscrow artifact and the demo's accounts. Run scripts with
// node --env-file=.env --env-file=../cardano/apps/payonproof/.env src/creator/<script>.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Abi, type Address, createPublicClient, createWalletClient, fallback, type Hex, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const artifact = JSON.parse(
  readFileSync(new URL('../../out/CreatorDealEscrow.sol/CreatorDealEscrow.json', import.meta.url), 'utf8')
);
export const ESCROW_ABI = artifact.abi as Abi;
export const ESCROW_BYTECODE = artifact.bytecode.object as Hex;

// DemoUSD (dUSD, 6 decimals) from the PayOnProof deployment: anyone can mint, so the brand mints its own budget.
export const DUSD: Address = '0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf';
export const DUSD_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

// The public endpoint rate-limits (429), so fall back to a second public one.
const transport = fallback([
  http(process.env.RPC_URL, { retryCount: 4, retryDelay: 800 }),
  http('https://base-sepolia-rpc.publicnode.com', { retryCount: 4, retryDelay: 800 }),
]);
export const publicClient = createPublicClient({ chain: baseSepolia, transport });

const key = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value as Hex;
};
// The brand also deploys. The settlement agent pays for data in aUSD over x402 and for gas in ETH.
export const brandKey = () => key('KEEPER_EVM_PRIVATE_KEY');
export const agentKey = () => key('KEEPER_C_EVM_PRIVATE_KEY');
export const creatorAddress = () => privateKeyToAccount(key('CREATOR_EVM_PRIVATE_KEY')).address;

export const walletFor = (privateKey: Hex) =>
  createWalletClient({ account: privateKeyToAccount(privateKey), chain: baseSepolia, transport });

const DEPLOYMENT = new URL('./deployment.json', import.meta.url);
export const readDeployment = (): { escrow: Address; deployTx: Hex } => {
  if (!existsSync(DEPLOYMENT)) throw new Error('No deployment yet: run src/creator/deploy.ts');
  return JSON.parse(readFileSync(DEPLOYMENT, 'utf8'));
};
export const writeDeployment = (value: { escrow: Address; deployTx: Hex }) =>
  writeFileSync(DEPLOYMENT, JSON.stringify(value, null, 2) + '\n');

export const txLink = (hash: Hex) => `https://sepolia.basescan.org/tx/${hash}`;

// Waits for the receipt and throws unless the transaction succeeded.
export const confirm = async (hash: Hex, label: string) => {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${receipt.status} (gas ${receipt.gasUsed}) ${txLink(hash)}`);
  if (receipt.status !== 'success') throw new Error(`${label} reverted`);
  return receipt;
};
