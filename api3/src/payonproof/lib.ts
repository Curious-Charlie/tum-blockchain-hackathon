/**
 * PayOnProof, single chain (Base Sepolia only): shared pieces of the agent scripts.
 *
 * Keys come from api3/.env (PRIVATE_KEY: Lena's treasury) and cardano/apps/payonproof/.env
 * (KEEPER_B_EVM_PRIVATE_KEY: Keeper Swift). They are never printed.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  fallback,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  toEventSelector,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { verifySignedResponse, type SignedResponse } from '../airnode-v2.ts';
import { createPayingFetch, readPaymentSettlement } from '../x402.ts';

const API3_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const file of [path.join(API3_DIR, '.env'), path.join(API3_DIR, '..', 'cardano', 'apps', 'payonproof', '.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

// ---------------------------------------------------------------- deployment

/** InvoiceEscrowV2 on Base Sepolia (script/DeployInvoiceEscrowV2.s.sol) */
export const ESCROW_V2: Address = (process.env.ESCROW_V2 as Address | undefined) ?? '0xec121b9f115999031d5d2f746affe4d671791a12';
/** PayOnProof v1 escrow: its InvoicePaid events are part of a Keeper's record */
export const ESCROW_V1: Address = '0x63e2b722725eda487a9d76962ef4633dcc5e571a';
export const ESCROW_V1_BLOCK = 52176173n;
/** DemoUSD (dUSD, 6 decimals) from the v1 deployment */
export const DUSD: Address = '0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf';

export const EXPLORER = 'https://sepolia.basescan.org';
export const txLink = (hash: Hex) => `${EXPLORER}/tx/${hash}`;
export const addressLink = (address: Address) => `${EXPLORER}/address/${address}`;

// The public endpoint answers 429 under load, so fall back to a second public endpoint and retry.
const transport = fallback(
  [process.env.RPC_URL ?? 'https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'].map((url) => http(url, { retryCount: 6, retryDelay: 1_000 })),
);
export const client = createPublicClient({ chain: baseSepolia, transport });

const key = (name: string): Hex => {
  const value = process.env[name];
  if (!value?.startsWith('0x')) throw new Error(`Set ${name} in api3/.env or cardano/apps/payonproof/.env`);
  return value as Hex;
};
export const lena = createWalletClient({ account: privateKeyToAccount(key('PRIVATE_KEY')), chain: baseSepolia, transport });
export const SWIFT_KEY = key('KEEPER_B_EVM_PRIVATE_KEY');
export const swift = createWalletClient({ account: privateKeyToAccount(SWIFT_KEY), chain: baseSepolia, transport });

/** Suppliers in Lena's address book: deterministic demo addresses, as in the Cardano version */
const supplier = (slug: string) => privateKeyToAddress(keccak256(stringToHex(`payonproof:supplier:${slug}`)));
export const SUPPLIERS = {
  cafeverde: { name: 'Café Verde (Colombia)', address: supplier('cafe-verde') },
  fazendaalta: { name: 'Fazenda Alta (Brazil)', address: supplier('fazenda-alta') },
};

// ---------------------------------------------------------------- contract

export const escrowAbi = parseAbi([
  'function createOrder(bytes32 invoiceRef, address payee, address token, uint256 amountEurCents, uint256 maxRate, uint64 deadline, address keeper, uint256 keeperFee) returns (uint256 orderId)',
  'function execute(uint256 orderId, uint256 timestamp, bytes data, bytes signature) returns (uint256 payout)',
  'function cancel(uint256 orderId)',
  'function getOrder(uint256 orderId) view returns ((address payer, address payee, address token, uint8 status, uint64 deadline, uint64 exclusiveUntil, address keeper, uint256 amountEurCents, uint256 maxRate, uint256 deposit, uint256 keeperFee, bytes32 invoiceRef))',
  'function orderCount() view returns (uint256)',
  'function quote(address token, uint256 amountEurCents, uint256 rate) view returns (uint256)',
  'event OrderCreated(uint256 indexed orderId, address indexed payer, address indexed payee, bytes32 invoiceRef, address token, uint256 amountEurCents, uint256 maxRate, uint256 deposit, uint64 deadline, address keeper, uint256 keeperFee, uint64 exclusiveUntil)',
  'event InvoicePaid(uint256 indexed orderId, address indexed executor, address indexed payee, bytes32 requestHash, uint256 responseTimestamp, uint256 rate, uint256 rateTimestamp, uint256 payout, uint256 keeperFee, uint256 refund)',
  'event OrderCancelled(uint256 indexed orderId, uint256 refund)',
  'error InvalidOrder()',
  'error OrderNotOpen(uint256 orderId, uint8 status)',
  'error OrderExpired(uint256 orderId, uint64 deadline)',
  'error NotPayer(address caller)',
  'error KeeperOnly(address keeper, uint64 exclusiveUntil)',
  'error ResponseTooOld(uint256 responseTimestamp)',
  'error RateTooOld(uint256 rateTimestamp)',
  'error ConditionNotMet(uint256 rate, uint256 maxRate)',
  'error NotSignedByAirnode(address signer)',
  'error ECDSAInvalidSignature()',
  'error ECDSAInvalidSignatureLength(uint256 length)',
  'error ECDSAInvalidSignatureS(bytes32 s)',
  'error SafeERC20FailedOperation(address token)',
]);
export const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
export const usd = (units: bigint) => `${formatUnits(units, 6)} dUSD`;
export const STATUS = ['None', 'Open', 'Paid', 'Cancelled'] as const;

/** viem's revert errors run to hundreds of lines; this keeps the contract's error name and arguments. */
export function explainRevert(error: unknown): never {
  const revert = error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError && revert.data) {
    throw new Error(`${revert.data.errorName}(${(revert.data.args ?? []).map(String).join(', ')})`);
  }
  throw error instanceof BaseError ? new Error(error.shortMessage) : error;
}

/** Waits for a receipt and fails unless it succeeded */
export async function confirm(hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 2_000, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`reverted: ${txLink(hash)}`);
  return receipt;
}

// ---------------------------------------------------------------- Nodary EUR/USD

export const NODARY_URL = 'https://airnode-nodary.fly.dev/';
export const NODARY_AIRNODE: Address = '0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0';
export const EUR_USD_REQUEST_HASH: Hex = '0x5ccc3aa98c84e0929a84c28f3fe16c2a89b2e58965b487b5580af40be401d3d0';

export interface SignedRate {
  signed: SignedResponse;
  rate: bigint;
  display: string;
}

/** A signed Nodary price for a feed, projected to {"price","updatedAt"} like the escrow's request */
export async function fetchSignedFeed(feed: string): Promise<SignedResponse> {
  const pointer = feed.replaceAll('~', '~0').replaceAll('/', '~1');
  const response = await fetch(NODARY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'latestFeeds', parameters: { name: feed }, responseProjection: { price: `/${pointer}/value`, updatedAt: `/${pointer}/timestamp` } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Nodary answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as SignedResponse;
}

/** Signed EUR/USD, with the contract's signer and request checks made off chain first */
export async function fetchSignedRate(): Promise<SignedRate> {
  const signed = await fetchSignedFeed('EUR/USD');
  await verifySignedResponse(signed, NODARY_AIRNODE, EUR_USD_REQUEST_HASH);
  const { price } = JSON.parse(signed.data) as { price: number };
  return { signed, rate: toRate(price), display: String(price) };
}

/** 1.1204 → 1.1204e18, exactly as ProjectedJson.readUint(data, "price", 18) reads it */
export function toRate(value: number): bigint {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0').slice(0, 18) || '0');
}
export const showRate = (rate: bigint) => formatUnits(rate, 18);

// ---------------------------------------------------------------- Frankfurter over x402

export const FRANKFURTER_URL = 'https://airnode-frankfurter.fly.dev/';
export const FRANKFURTER_AIRNODE: Address = '0x230078619710911032BEF192918203359E7DB22f';
const FRANKFURTER_REQUEST = { operation: 'getRate', parameters: { base: 'EUR', quote: 'USD' } };
export const FRANKFURTER_REQUEST_HASH = keccak256(
  stringToHex(JSON.stringify([FRANKFURTER_REQUEST.operation, Object.entries(FRANKFURTER_REQUEST.parameters).sort(([a], [b]) => (a < b ? -1 : 1))])),
);
export const MAX_DEVIATION = 0.01;

/** The Keeper pays 0.01 aUSD over x402 for Frankfurter's signed EUR/USD, a second source it checks before it executes */
export async function buySecondRate(payerKey: Hex) {
  const response = await createPayingFetch(payerKey)(FRANKFURTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(FRANKFURTER_REQUEST),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Frankfurter answered ${response.status}: ${(await response.text()).slice(0, 120)}`);
  const signed = (await response.json()) as SignedResponse;
  await verifySignedResponse(signed, FRANKFURTER_AIRNODE, FRANKFURTER_REQUEST_HASH);
  const data = JSON.parse(signed.data) as { rate?: number; date?: string } | { rate?: number; date?: string }[];
  const record = Array.isArray(data) ? data[0] : data;
  if (!record?.rate) throw new Error(`no rate in Frankfurter's response: ${signed.data.slice(0, 120)}`);
  const settlement = readPaymentSettlement(response) as { transaction?: Hex } | undefined;
  return { rate: record.rate, date: record.date ?? '?', paymentTx: settlement?.transaction };
}

// ---------------------------------------------------------------- Keeper records

const BLOCKSCOUT = 'https://base-sepolia.blockscout.com/api';
const V1_PAID = toEventSelector('InvoicePaid(uint256,address,uint256,uint256,uint256,uint256)');
const V2_PAID = toEventSelector('InvoicePaid(uint256,address,address,bytes32,uint256,uint256,uint256,uint256,uint256,uint256)');

/**
 * A Keeper's record, from public chain data only: the InvoicePaid events that the v1 and v2 escrows emitted with
 * the Keeper's account as the executor. Each one is a payment the contract accepted after checking a signed rate.
 * (The public RPC serves logs 200 blocks at a time, so this reads them from Blockscout's logs API.)
 */
export async function paidExecutions(executor: Address) {
  const topic = `0x${executor.slice(2).toLowerCase().padStart(64, '0')}`;
  const count = async (address: Address, topic0: Hex) => {
    const url = `${BLOCKSCOUT}?module=logs&action=getLogs&fromBlock=${ESCROW_V1_BLOCK}&toBlock=latest&address=${address}&topic0=${topic0}&topic2=${topic}&topic0_2_opr=and`;
    const body = (await (await fetch(url, { signal: AbortSignal.timeout(20_000) })).json()) as { result?: { transactionHash: Hex }[] | null };
    return body.result ?? [];
  };
  const [v1, v2] = await Promise.all([count(ESCROW_V1, V1_PAID), count(ESCROW_V2, V2_PAID)]);
  return { v1: v1.length, v2: v2.length, total: v1.length + v2.length, latest: (v2.at(-1) ?? v1.at(-1))?.transactionHash };
}
