/**
 * EVM side of PayOnProof: the InvoiceEscrow contract (api3/contracts/payonproof)
 * and Nodary's signed EUR/USD rate.
 *
 * Network: Base Sepolia when `deployments.json` has an escrow there, otherwise a
 * local anvil chain that this module starts and deploys to. Force one with
 * `EVM_NETWORK=base-sepolia|anvil`.
 *
 * Keys (never logged): Lena's treasury is api3/.env PRIVATE_KEY; the Keeper's
 * EVM key is KEEPER_EVM_PRIVATE_KEY in this app's .env, created on first use.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodePacked,
  formatUnits,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  recoverMessageAddress,
  stringToHex,
  hexToString,
  toHex,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";
import { ROOT, sleep } from "@agentic/core";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const API3_DIR = path.join(ROOT, "..", "api3");
const APP_ENV = path.join(APP_DIR, ".env");
const DEPLOYMENTS = path.join(APP_DIR, "deployments.json");
dotenv.config({ path: path.join(API3_DIR, ".env"), quiet: true });

// ---------------------------------------------------------------- Nodary EUR/USD

export const NODARY_URL = "https://airnode-nodary.fly.dev/";
export const NODARY_AIRNODE: Address = "0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0";
const FEED = "EUR/USD";
/** `pnpm --silent request-hash EUR/USD` in api3/: the escrow accepts only responses to this request. */
export const EUR_USD_REQUEST_HASH: Hex = "0x5ccc3aa98c84e0929a84c28f3fe16c2a89b2e58965b487b5580af40be401d3d0";

export interface SignedRate {
  airnode: Address;
  requestHash: Hex;
  timestamp: string;
  data: string;
  signature: Hex;
}

export interface CheckedRate {
  signed: SignedRate;
  /** EUR/USD with 18 decimals, as the contract reads it. */
  rate: bigint;
  /** "1.1204" */
  display: string;
  /** Unix seconds the Airnode signed at / Nodary took the rate at. */
  signedAt: number;
  takenAt: number;
}

/**
 * Fetches a signed EUR/USD response and makes the contract's signer and request
 * checks off chain, so a bad response never costs gas. The contract repeats them.
 */
export async function fetchSignedRate(): Promise<CheckedRate> {
  const signed = await fetchSignedFeed(FEED);
  if (signed.requestHash !== EUR_USD_REQUEST_HASH) throw new Error(`Response answers request ${signed.requestHash}, not EUR/USD`);
  const signer = await recoverSigner(signed);
  if (!isAddressEqual(signer, NODARY_AIRNODE)) throw new Error(`Response signed by ${signer}, not by Nodary`);
  const { price, updatedAt } = JSON.parse(signed.data) as { price: number; updatedAt: number };
  const [whole, fraction = ""] = String(price).split(".");
  const rate = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0").slice(0, 18) || "0");
  return { signed, rate, display: String(Number(price.toFixed(5))), signedAt: Number(signed.timestamp), takenAt: Math.floor(updatedAt / 1000) };
}

/** A signed Nodary price for any feed, projected to {"price","updatedAt"} like the EUR/USD request. */
export async function fetchSignedFeed(feed: string): Promise<SignedRate> {
  const pointer = feed.replaceAll("~", "~0").replaceAll("/", "~1");
  const response = await fetch(NODARY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "latestFeeds", parameters: { name: feed }, responseProjection: { price: `/${pointer}/value`, updatedAt: `/${pointer}/timestamp` } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Nodary answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as SignedRate;
}

/** Airnode v2 attestation: EIP-191 over keccak256(requestHash, timestamp, data). */
export const responseDigest = (requestHash: Hex, timestamp: string, data: string) =>
  keccak256(encodePacked(["bytes32", "uint256", "bytes"], [requestHash, BigInt(timestamp), toHex(data)]));

export const recoverSigner = (signed: SignedRate) =>
  recoverMessageAddress({ message: { raw: responseDigest(EUR_USD_REQUEST_HASH, signed.timestamp, signed.data) }, signature: signed.signature });

/** 1.11 → 1.11e18 */
export const toRate = (value: number): bigint => BigInt(Math.round(value * 1e6)) * 10n ** 12n;
export const showRate = (rate: bigint) => formatUnits(rate, 18).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

// ---------------------------------------------------------------- contracts

export const escrowAbi = parseAbi([
  "function createOrder(bytes32 invoiceRef, address payee, address token, uint256 amountEurCents, uint256 maxRate, uint64 deadline) returns (uint256 orderId)",
  "function execute(uint256 orderId, uint256 timestamp, bytes data, bytes signature) returns (uint256 payout)",
  "function cancel(uint256 orderId)",
  "function getOrder(uint256 orderId) view returns ((address payer, address payee, address token, uint8 status, uint64 deadline, uint256 amountEurCents, uint256 maxRate, uint256 deposit, bytes32 invoiceRef))",
  "function quote(address token, uint256 amountEurCents, uint256 rate) view returns (uint256)",
  "function maxRateAge() view returns (uint256)",
  "event OrderCreated(uint256 indexed orderId, address indexed payer, address indexed payee, bytes32 invoiceRef, address token, uint256 amountEurCents, uint256 maxRate, uint256 deposit, uint64 deadline)",
  "event InvoicePaid(uint256 indexed orderId, address indexed executor, uint256 rate, uint256 rateTimestamp, uint256 payout, uint256 refund)",
  "error InvalidOrder()",
  "error OrderNotOpen(uint256 orderId, uint8 status)",
  "error OrderExpired(uint256 orderId, uint64 deadline)",
  "error NotPayer(address caller)",
  "error ResponseTooOld(uint256 responseTimestamp)",
  "error RateTooOld(uint256 rateTimestamp)",
  "error ConditionNotMet(uint256 rate, uint256 maxRate)",
  "error NotSignedByAirnode(address signer)",
  "error ECDSAInvalidSignature()",
  "error ECDSAInvalidSignatureLength(uint256 length)",
  "error ECDSAInvalidSignatureS(bytes32 s)",
  "error SafeERC20FailedOperation(address token)",
]);

export const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function symbol() view returns (string)",
]);

export const STATUS = ["None", "Open", "Paid", "Cancelled"] as const;
export const USD_DECIMALS = 6;
export const usd = (units: bigint) => `${Number(formatUnits(units, USD_DECIMALS)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} dUSD`;

export interface Order {
  payer: Address;
  payee: Address;
  token: Address;
  status: number;
  deadline: bigint;
  amountEurCents: bigint;
  maxRate: bigint;
  deposit: bigint;
  invoiceRef: Hex;
}

export const invoiceRefOf = (order: Order) => hexToString(order.invoiceRef, { size: 32 }).replace(/\0+$/, "");

// ---------------------------------------------------------------- network

type NetworkName = "base-sepolia" | "anvil";
interface Deployment { escrow?: Address; usd?: Address }

const ANVIL_PORT = 4118;

function readDeployments(): Partial<Record<NetworkName, Deployment>> {
  return existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : {};
}

export function writeDeployment(network: NetworkName, deployment: Deployment) {
  const all = readDeployments();
  all[network] = { ...all[network], ...deployment };
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(all, null, 2)}\n`);
}

function requiredHex(name: string): Hex {
  const value = process.env[name];
  if (!value || !value.startsWith("0x")) throw new Error(`Set ${name} (0x-prefixed) in api3/.env or this app's .env`);
  return value as Hex;
}

/** The Keeper's own EVM key, so Lena's treasury and the Keeper are different accounts. */
export function keeperKey(): Hex {
  if (!process.env.KEEPER_EVM_PRIVATE_KEY) {
    const key = generatePrivateKey();
    appendFileSync(APP_ENV, `KEEPER_EVM_PRIVATE_KEY=${key}\n`);
    process.env.KEEPER_EVM_PRIVATE_KEY = key;
    console.log(`  Created the Keeper's EVM account ${privateKeyToAddress(key)} (key in apps/payonproof/.env)`);
  }
  return requiredHex("KEEPER_EVM_PRIVATE_KEY");
}

export function lenaKey(): Hex {
  return (process.env.LENA_EVM_PRIVATE_KEY as Hex | undefined) ?? requiredHex("PRIVATE_KEY");
}

/** Reads a contract's creation bytecode from `forge build` output in api3/out. */
export function bytecode(contract: string): Hex {
  const file = path.join(API3_DIR, "out", `${contract}.sol`, `${contract}.json`);
  if (!existsSync(file)) execFileSync("forge", ["build"], { cwd: API3_DIR, stdio: "ignore" });
  return (JSON.parse(readFileSync(file, "utf8")) as { bytecode: { object: Hex } }).bytecode.object;
}

export type Evm = Awaited<ReturnType<typeof connectEvm>>;

/** Connects to Base Sepolia (deployed escrow) or starts anvil and deploys there. */
export async function connectEvm(requested?: string) {
  const deployments = readDeployments();
  const name: NetworkName = (requested ?? process.env.EVM_NETWORK ?? (deployments["base-sepolia"]?.escrow ? "base-sepolia" : "anvil")) as NetworkName;
  if (name !== "base-sepolia" && name !== "anvil") throw new Error(`Unknown EVM network ${name}`);

  let chain: Chain;
  let rpcUrl: string;
  let anvil: ChildProcess | undefined;
  if (name === "base-sepolia") {
    chain = baseSepolia;
    rpcUrl = process.env.RPC_URL ?? "https://sepolia.base.org";
  } else {
    chain = foundry;
    rpcUrl = `http://127.0.0.1:${ANVIL_PORT}`;
    anvil = await startAnvil(rpcUrl);
  }

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const lena = createWalletClient({ account: privateKeyToAccount(lenaKey()), chain, transport });
  const keeper = createWalletClient({ account: privateKeyToAccount(keeperKey()), chain, transport });

  let deployment: Required<Deployment>;
  if (name === "anvil") {
    const test = createTestClient({ chain, transport, mode: "anvil" });
    for (const address of [lena.account.address, keeper.account.address]) await test.setBalance({ address, value: parseEther("10") });
    const deploy = async (contract: string, args: readonly unknown[] = []) => {
      const hash = await lena.deployContract({ abi: [{ type: "constructor", inputs: args.length ? [{ type: "bytes32" }, { type: "uint256" }] : [], stateMutability: "nonpayable" }], bytecode: bytecode(contract), args });
      return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
    };
    deployment = { usd: await deploy("DemoUSD"), escrow: await deploy("InvoiceEscrow", [EUR_USD_REQUEST_HASH, 3n * 24n * 3600n]) };
  } else {
    const found = deployments["base-sepolia"];
    if (!found?.escrow || !found.usd) throw new Error("No Base Sepolia deployment in deployments.json: run `npm run deploy -w apps/payonproof`");
    deployment = { escrow: found.escrow, usd: found.usd };
  }

  const explorer = name === "base-sepolia" ? "https://sepolia.basescan.org" : undefined;
  const txLink = (hash: Hex) => (explorer ? `${explorer}/tx/${hash}` : `anvil tx ${hash}`);
  const addressLink = (address: Address) => (explorer ? `${explorer}/address/${address}` : `anvil ${address}`);

  /** Waits for a receipt; throws if the transaction reverted. */
  const confirm = async (hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`Transaction reverted: ${txLink(hash)}`);
    return receipt;
  };

  return {
    name,
    chain,
    explorer,
    txLink,
    addressLink,
    escrow: deployment.escrow,
    usdToken: deployment.usd,
    lenaAddress: lena.account.address,
    keeperAddress: keeper.account.address,

    async getOrder(orderId: bigint): Promise<Order> {
      return (await publicClient.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: "getOrder", args: [orderId] })) as Order;
    },

    async usdBalance(address: Address) {
      return publicClient.readContract({ address: deployment.usd, abi: tokenAbi, functionName: "balanceOf", args: [address] });
    },

    async ethBalance(address: Address) {
      return publicClient.getBalance({ address });
    },

    /** Lena locks the invoice at her limit rate. Mints demo dollars and approves the escrow when needed. */
    async createOrder(input: { invoiceRef: string; payee: Address; amountEurCents: bigint; maxRate: bigint; deadline: bigint }) {
      const deposit = await publicClient.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: "quote", args: [deployment.usd, input.amountEurCents, input.maxRate] });
      const send = async (request: Parameters<typeof lena.writeContract>[0]) => {
        const hash = await lena.writeContract(request).catch(explainRevert);
        await confirm(hash);
        return hash;
      };
      if ((await this.usdBalance(lena.account.address)) < deposit) {
        await send({ address: deployment.usd, abi: tokenAbi, functionName: "mint", args: [lena.account.address, 10_000n * 10n ** 6n], account: lena.account, chain });
      }
      const allowance = await publicClient.readContract({ address: deployment.usd, abi: tokenAbi, functionName: "allowance", args: [lena.account.address, deployment.escrow] });
      if (allowance < deposit) {
        await send({ address: deployment.usd, abi: tokenAbi, functionName: "approve", args: [deployment.escrow, 2n ** 255n], account: lena.account, chain });
      }
      const hash = await lena.writeContract({
        address: deployment.escrow, abi: escrowAbi, functionName: "createOrder", account: lena.account, chain,
        args: [stringToHex(input.invoiceRef, { size: 32 }), input.payee, deployment.usd, input.amountEurCents, input.maxRate, input.deadline],
      }).catch(explainRevert);
      const receipt = await confirm(hash);
      const [created] = parseEventLogs({ abi: escrowAbi, eventName: "OrderCreated", logs: receipt.logs });
      if (!created) throw new Error(`No OrderCreated event in ${txLink(hash)}`);
      return { orderId: created.args.orderId, deposit: created.args.deposit, hash };
    },

    /** Dry run (eth_call) of `execute`: undefined if the escrow would accept the response, else its error. */
    async simulate(orderId: bigint, signed: Pick<SignedRate, "timestamp" | "data" | "signature">): Promise<string | undefined> {
      const args = [orderId, BigInt(signed.timestamp), toHex(signed.data), signed.signature] as const;
      return publicClient.simulateContract({ address: deployment.escrow, abi: escrowAbi, functionName: "execute", args, account: keeper.account })
        .then(() => undefined, (error) => { try { explainRevert(error); } catch (e) { return (e as Error).message; } });
    },

    /** The Keeper submits the signed rate. Simulates first, so a failing call costs no gas. */
    async execute(orderId: bigint, signed: Pick<SignedRate, "timestamp" | "data" | "signature">) {
      const args = [orderId, BigInt(signed.timestamp), toHex(signed.data), signed.signature] as const;
      const { request } = await publicClient.simulateContract({ address: deployment.escrow, abi: escrowAbi, functionName: "execute", args, account: keeper.account }).catch(explainRevert);
      const hash = await keeper.writeContract(request);
      const receipt = await confirm(hash);
      const [paid] = parseEventLogs({ abi: escrowAbi, eventName: "InvoicePaid", logs: receipt.logs });
      if (!paid) throw new Error(`No InvoicePaid event in ${txLink(hash)}`);
      return { hash, payout: paid.args.payout, refund: paid.args.refund, rate: paid.args.rate, block: receipt.blockNumber };
    },

    close() {
      anvil?.kill();
    },
  };
}

/** viem's revert errors run to hundreds of lines; this keeps the contract's error name and arguments. */
export function explainRevert(error: unknown): never {
  const revert = error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError && revert.data) {
    const args = (revert.data.args ?? []).map((arg) => (typeof arg === "bigint" && arg > 10n ** 15n ? showRate(arg) : String(arg)));
    throw new Error(`contract rejected it: ${revert.data.errorName}(${args.join(", ")})`);
  }
  throw error instanceof BaseError ? new Error(error.shortMessage) : error;
}

async function startAnvil(rpcUrl: string): Promise<ChildProcess> {
  const child = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  child.on("error", (error) => console.error(`anvil failed to start: ${error.message} (install Foundry)`));
  process.once("exit", () => child.kill());
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return child;
    await sleep(200);
  }
  throw new Error(`anvil did not start on ${rpcUrl}`);
}
