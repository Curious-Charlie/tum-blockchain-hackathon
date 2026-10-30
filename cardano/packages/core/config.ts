/**
 * Environment, network constants, asset helpers and the Blockfrost REST helper.
 *
 * Env loading: the app's own .env (current directory) first, then cardano/.env.
 * dotenv never overrides a variable that is already set, so app values win.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { CardanoProviderConfig } from "@x402/cardano";

/** The cardano/ directory: shared .env, audit logs and caches live here. */
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

export const NETWORK = "cardano:preprod" as const;
export const BLOCKFROST_URL = "https://cardano-preprod.blockfrost.io/api/v0";
export const EXPLORER_TX = "https://preprod.cardanoscan.io/transaction/";
export const EXPLORER_ADDRESS = "https://preprod.cardanoscan.io/address/";

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env (npm run wallets creates wallet mnemonics).`);
  return value;
}

/** Blockfrost only: with Koios the SDK cannot confirm settlement (see CLAUDE.md). */
export function provider(): CardanoProviderConfig {
  return { blockfrost: { baseUrl: BLOCKFROST_URL, projectId: required("BLOCKFROST_PROJECT_ID") } };
}

// ---------------------------------------------------------------- assets

export const LOVELACE = "lovelace";
/** tUSDM from the Masumi dispenser (not the SDK's default preprod USDM). */
export const TUSDM = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";

export const ASSETS: Record<string, { symbol: string; decimals: number }> = {
  [LOVELACE]: { symbol: "tADA", decimals: 6 },
  [TUSDM]: { symbol: "tUSDM", decimals: 6 },
};

/** An amount in an asset's smallest unit. */
export interface Amount {
  asset: string;
  amount: bigint;
}

const toUnits = (value: number) => BigInt(Math.round(value * 1e6));
export const ada = (value: number): Amount => ({ asset: LOVELACE, amount: toUnits(value) });
export const usdm = (value: number): Amount => ({ asset: TUSDM, amount: toUnits(value) });

export function symbolOf(asset: string): string {
  return ASSETS[asset]?.symbol ?? `${asset.slice(0, 8)}…`;
}

/** "1.5 tADA" */
export function formatAmount(asset: string, amount: bigint | string): string {
  const decimals = ASSETS[asset]?.decimals ?? 0;
  const value = Number(BigInt(amount)) / 10 ** decimals;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: decimals })} ${symbolOf(asset)}`;
}

export const shortAddress = (address: string) => `${address.slice(0, 12)}…${address.slice(-6)}`;

// ---------------------------------------------------------------- Blockfrost

/** GET a Blockfrost path. Returns undefined on 404. Starter plan: 50k requests a day, so no tight loops. */
export async function blockfrost<T>(pathname: string): Promise<T | undefined> {
  const response = await fetch(`${BLOCKFROST_URL}${pathname}`, {
    headers: { project_id: required("BLOCKFROST_PROJECT_ID") },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Blockfrost ${pathname} returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until a transaction is in a block. Polls every 5 s. */
export async function waitForTx(txHash: string, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await blockfrost(`/txs/${txHash}`)) return;
    await sleep(5_000);
  }
  throw new Error(`Transaction ${txHash} not confirmed after ${timeoutMs / 1000} s`);
}
