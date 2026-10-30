/**
 * The current Nodary-signed EUR/USD and how old it is (FX markets close for the
 * weekend, so the rate can stop moving while the signatures stay fresh).
 *
 *   npm run rate -w apps/payonproof
 */
import { fetchSignedRate } from "./evm.ts";

const MAX_RATE_AGE_S = 3 * 24 * 3600; // InvoiceEscrow's maxRateAge
const ago = (s: number, seconds = Math.max(0, s)) => (seconds < 120 ? `${seconds} s` : seconds < 7200 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`);
const now = Math.floor(Date.now() / 1000);
const rate = await fetchSignedRate();
console.log(`Nodary-signed EUR/USD ${rate.display}`);
console.log(`  rate taken   ${new Date(rate.takenAt * 1000).toISOString()} (${ago(now - rate.takenAt)} ago; the escrow accepts up to 3 days)`);
console.log(`  signed       ${new Date(rate.signedAt * 1000).toISOString()} (${ago(now - rate.signedAt)} ago; the escrow accepts up to 5 min)`);
console.log(now - rate.takenAt <= MAX_RATE_AGE_S ? "  → usable by InvoiceEscrow" : "  → too old for InvoiceEscrow");
