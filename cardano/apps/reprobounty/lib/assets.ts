/**
 * tUSDM in the form x402 accepts. @x402/cardano requires the canonical
 * "policyId.assetNameHex" (with a dot); core's TUSDM constant has no dot, so a
 * Seller pricing in core's usdm() fails with "AssetAmount asset must use
 * canonical lowercase Cardano form". Workaround until core fixes it: price in
 * the dotted unit and register its display name in core's ASSETS table.
 */
import { ASSETS, TUSDM, type Amount } from "@agentic/core";

export const TUSDM_X402 = `${TUSDM.slice(0, 56)}.${TUSDM.slice(56)}`;
ASSETS[TUSDM_X402] = ASSETS[TUSDM]!;

export const tusdm = (value: number): Amount => ({ asset: TUSDM_X402, amount: BigInt(Math.round(value * 1e6)) });
