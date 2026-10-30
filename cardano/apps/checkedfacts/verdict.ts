/**
 * The money rule of CheckedFacts, as plain deterministic code. No LLM decides
 * whether the customer pays: Claude (Haiku) only labels one claim at a time as
 * supported or not, after code has proven the quote is really on the page.
 *
 *   checkable = claims whose source page could be fetched
 *   pass rate = supported / checkable
 *   settle    ⇔ checkable ≥ MIN_CHECKABLE  and  pass rate ≥ PASS_THRESHOLD
 *
 * An unverifiable claim (source down, bot wall, PDF) is neither counted as
 * fabricated nor as supported; the report flags it. MIN_CHECKABLE stops a
 * report from passing by citing only pages nobody can open.
 */
import { createHash } from "node:crypto";

export interface Claim {
  id: number;
  /** One factual statement for the customer. */
  claim: string;
  /** Source page. */
  url: string;
  /** Verbatim text from that page that supports the claim. */
  quote: string;
}

export type CheckVerdict =
  | "supported" //        quote is on the page and supports the claim
  | "unsupported" //      quote is on the page but does not support the claim
  | "quote_not_found" //  page fetched, quote is not on it: misquoted or misattributed
  | "unverifiable"; //    page could not be fetched: neither pass nor fail

export interface CheckResult {
  id: number;
  verdict: CheckVerdict;
  /** One line: why. */
  reason: string;
}

export const PASS_THRESHOLD = 0.85;
export const MIN_CHECKABLE = 5;

export interface GateResult {
  pass: boolean;
  total: number;
  checkable: number;
  supported: number;
  unverifiable: number;
  failed: number;
  passRate: number;
  summary: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function gate(results: CheckResult[], threshold = PASS_THRESHOLD, minCheckable = MIN_CHECKABLE): GateResult {
  const total = results.length;
  const unverifiable = results.filter((r) => r.verdict === "unverifiable").length;
  const supported = results.filter((r) => r.verdict === "supported").length;
  const checkable = total - unverifiable;
  const failed = checkable - supported;
  const passRate = checkable ? supported / checkable : 0;
  const rate = `${supported}/${checkable} checkable claims supported (${pct(passRate)})`;
  let pass = true;
  let summary: string;
  if (checkable < minCheckable) {
    pass = false;
    summary = `only ${checkable} of ${total} claims could be checked; at least ${minCheckable} are required`;
  } else if (passRate < threshold) {
    pass = false;
    summary = `${rate} is below the ${pct(threshold)} threshold`;
  } else {
    summary = `${rate} meets the ${pct(threshold)} threshold`;
  }
  if (unverifiable) summary += `; ${unverifiable} unverifiable (source unreachable)`;
  return { pass, total, checkable, supported, unverifiable, failed, passRate, summary };
}

/** sha256 of the claims as checked (id, claim, url, quote), so a report can be matched to its certificate. */
export function claimsHash(claims: Claim[]): string {
  const canonical = [...claims].sort((a, b) => a.id - b.id).map(({ id, claim, url, quote }) => ({ id, claim, url, quote }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** One letter per verdict, for the on-chain certificate. */
export const CODE: Record<CheckVerdict, string> = { supported: "S", unsupported: "U", quote_not_found: "Q", unverifiable: "?" };

/** The verdict label shown in tables. */
export const LABEL: Record<CheckVerdict, string> = {
  supported: "✔ supported",
  unsupported: "✘ not supported",
  quote_not_found: "✘ quote not on page",
  unverifiable: "? unverifiable",
};
