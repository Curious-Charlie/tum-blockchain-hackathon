/** Prices, ports and the demo topic of CheckedFacts. */
import { usdm } from "@agentic/core";

export const RESEARCHER_PORT = Number(process.env.RESEARCHER_PORT ?? 4120);
export const CHECKER_PORT = Number(process.env.CHECKER_PORT ?? 4121);
export const VENDOR_PORT = Number(process.env.VENDOR_PORT ?? 4124);

/** What the shop owner pays for a report, only if it passes the fact-check. */
export const REPORT_PRICE = usdm(3);
/** What the research agent pays the fact-checker per claim checked. */
export const CHECK_PRICE_PER_CLAIM = usdm(0.2);
/** Claims per paid check request; a report of 8 claims costs two payments. */
export const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 4);
export const MAX_BATCH = 5;
/** The research agent keeps at most this many claims in a report. */
export const MAX_CLAIMS = 8;

export const DEFAULT_TOPIC = "Competitive landscape of specialty coffee shops and roasters in Munich, Germany";
