/** Prices, ports and the demo topic of CheckedFacts. */
import { ASSETS, TUSDM, type Amount } from "@agentic/core";

/**
 * tUSDM in the x402 wire form `<policy id>.<asset name>`. Core's TUSDM is the
 * Blockfrost unit (no dot), which the x402 Cardano scheme rejects as a price
 * ("asset must use canonical lowercase Cardano form"). Registered in ASSETS so
 * core's formatAmount still prints "tUSDM".
 */
export const TUSDM_X402 = `${TUSDM.slice(0, 56)}.${TUSDM.slice(56)}`;
ASSETS[TUSDM_X402] = { symbol: "tUSDM", decimals: 6 };
export const tusdm = (value: number): Amount => ({ asset: TUSDM_X402, amount: BigInt(Math.round(value * 1e6)) });

export const RESEARCHER_PORT = Number(process.env.RESEARCHER_PORT ?? 4120);
export const CHECKER_PORT = Number(process.env.CHECKER_PORT ?? 4121);
export const VENDOR_PORT = Number(process.env.VENDOR_PORT ?? 4124);

/** What the shop owner pays for a report, only if it passes the fact-check. */
export const REPORT_PRICE = tusdm(3);
/** What the research agent pays the fact-checker per claim checked. */
export const CHECK_PRICE_PER_CLAIM = tusdm(0.2);
/** Claims per paid check request by default: a report of 8 claims costs two payments. */
export const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 4);
/** Most claims the checker takes in one request (`--fast` sends them all at once: one payment, no confirmation wait). */
export const MAX_BATCH = 8;
/** Pause after a confirmation before spending again: Blockfrost's UTxO index trails new blocks. */
export const INDEX_LAG_MS = Number(process.env.INDEX_LAG_MS ?? 12_000);
/** The research agent keeps at most this many claims in a report. */
export const MAX_CLAIMS = 8;

export const DEFAULT_TOPIC = "Competitive landscape of specialty coffee shops and roasters in Munich, Germany";
