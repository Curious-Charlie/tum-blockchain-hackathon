/**
 * A second opinion on the rate, bought over x402 on AirnodeHub.
 *
 * When Nodary's signed EUR/USD says an order may execute, the Keeper first pays
 * 0.01 aUSD (Base Sepolia, x402 "exact": an EIP-3009 authorization that the
 * Airnode's facilitator submits, so the Keeper needs aUSD but no ETH) for
 * Frankfurter's signed EUR/USD, a blend of central-bank reference rates. It
 * checks that response's signer and request like the contract checks Nodary's,
 * and executes only if the two sources agree within 1 %. The contract still
 * trusts only Nodary; this makes the Keeper refuse to act on an outlier, and it
 * pays for the second source only when it is about to move money.
 */
import { ExactEvmScheme } from "@x402/evm";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { isAddressEqual, keccak256, recoverMessageAddress, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { responseDigest } from "./evm.ts";

export const FRANKFURTER_URL = "https://airnode-frankfurter.fly.dev/";
/** The listing's Airnode address (GET on the listing URL, `x-airnode.address`). */
export const FRANKFURTER_AIRNODE: Address = "0x230078619710911032BEF192918203359E7DB22f";
/** AirnodeHub USD on Base Sepolia, 6 decimals: the only asset the Airnodes accept. */
export const AUSD: Address = "0xbeA34973e5f67F18F656A2C6070C64326C791808";
const BASE_SEPOLIA = "eip155:84532";
export const MAX_DEVIATION = 0.01;

const REQUEST = { operation: "getRate", parameters: { base: "EUR", quote: "USD" } };
/** keccak256 of [operation, parameter entries sorted by name], as AirnodeHub documents it. */
export const FRANKFURTER_REQUEST_HASH = keccak256(stringToHex(JSON.stringify([REQUEST.operation, Object.entries(REQUEST.parameters).sort(([a], [b]) => (a < b ? -1 : 1))])));

export interface SecondRate {
  source: "Frankfurter (AirnodeHub)";
  rate: number;
  /** The reference date Frankfurter quotes. */
  date: string;
  signedAt: number;
  /** Base Sepolia transaction that moved the 0.01 aUSD, if the Airnode reported it. */
  paymentTx?: Hex;
}

export async function buySecondRate(payerKey: Hex): Promise<SecondRate> {
  const pay = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: BASE_SEPOLIA, client: new ExactEvmScheme(privateKeyToAccount(payerKey)) }],
    spendControls: { allowedAssets: [{ network: BASE_SEPOLIA, asset: AUSD, maxAmountPerPayment: "50000" }] }, // at most 0.05 aUSD
    policies: [(_version, requirements) => requirements.filter((r) => r.asset.toLowerCase() === AUSD.toLowerCase())],
  });
  const response = await pay(FRANKFURTER_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(REQUEST), signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`Frankfurter answered ${response.status}: ${(await response.text()).slice(0, 120)}`);
  const signed = (await response.json()) as { requestHash: Hex; timestamp: string; data: string; signature: Hex };
  if (signed.requestHash !== FRANKFURTER_REQUEST_HASH) throw new Error(`Frankfurter answered request ${signed.requestHash}, not EUR→USD`);
  const signer = await recoverMessageAddress({ message: { raw: responseDigest(signed.requestHash, signed.timestamp, signed.data) }, signature: signed.signature });
  if (!isAddressEqual(signer, FRANKFURTER_AIRNODE)) throw new Error(`Frankfurter response signed by ${signer}`);
  const data = JSON.parse(signed.data) as { rate?: number; date?: string } | { rate?: number; date?: string }[];
  const record = Array.isArray(data) ? data[0] : data;
  if (!record?.rate) throw new Error(`no rate in Frankfurter's response: ${signed.data.slice(0, 120)}`);
  const header = response.headers.get("PAYMENT-RESPONSE");
  const settlement = header ? (decodePaymentResponseHeader(header) as { transaction?: Hex }) : undefined;
  return { source: "Frankfurter (AirnodeHub)", rate: record.rate, date: record.date ?? "?", signedAt: Number(signed.timestamp), paymentTx: settlement?.transaction };
}
