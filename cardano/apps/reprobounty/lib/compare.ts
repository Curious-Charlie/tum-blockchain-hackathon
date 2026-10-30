/**
 * Deterministic claim checking. Claude only proposes claims (read from the
 * paper) and a mapping from claims to output columns; this file decides,
 * with plain arithmetic, whether the numbers match and what the verdict is.
 */

/** A claim as Claude extracts it from the manuscript. */
export interface ExtractedClaim {
  id: string;
  description: string;
  symbol: string;
  /** The number exactly as printed, e.g. "-0.06". */
  value_text: string;
  /** Which datasets / table rows the claim is about, in the paper's words. */
  applies_to: string;
  /** Verbatim fragment of the manuscript that contains the number. */
  quote: string;
}

export interface ValidClaim extends ExtractedClaim {
  value: number;
  /** Decimals printed in the paper. */
  decimals: number;
  /** Allowed |computed - claimed|: one unit in the last printed digit. */
  tolerance: number;
}

/** Claude's proposal of where a claim's number is in the outputs. */
export interface Mapping {
  claim_id: string;
  file: string;
  column: string;
  reason: string;
}

export interface CheckRow {
  claim: string;
  symbol: string;
  file: string;
  dataset: string;
  claimed: number;
  computed: number;
  diff: number;
  tolerance: number;
  ok: boolean;
  /** Same number when the computed value is rounded / truncated to the printed decimals. */
  rounds: boolean;
  truncates: boolean;
}

export type Verdict = "REPRODUCED" | "PARTIAL" | "NOT REPRODUCED";

export interface ClaimResult {
  claim: string;
  symbol: string;
  claimed: string;
  matched: number;
  total: number;
  range: [number, number];
}

export interface Comparison {
  verdict: Verdict;
  rows: CheckRow[];
  claims: ClaimResult[];
  passed: number;
  total: number;
  /** Matches under each reporting convention, for the report. */
  rounding: number;
  truncation: number;
  rule: string;
}

export const VERDICT_RULE =
  "check: |computed - claimed| < one unit in the last printed digit. " +
  "REPRODUCED: every check passes. NOT REPRODUCED: some claimed number is contradicted by every dataset it applies to. PARTIAL: otherwise.";

const normalize = (text: string) =>
  text.normalize("NFKC").replace(/[−–]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/** Number and printed decimals of "−0.06", "+0.32", "54.26". */
export function parseNumber(text: string): { value: number; decimals: number } | undefined {
  const match = /^[+-]?\d+(?:\.(\d+))?$/.exec(normalize(text));
  if (!match) return undefined;
  return { value: Number(normalize(text)), decimals: match[1]?.length ?? 0 };
}

/**
 * Keeps only claims whose number is really printed in the manuscript (guards
 * against a hallucinated or injected number) and derives the tolerance from
 * the printed precision.
 */
export function validateClaims(claims: ExtractedClaim[], manuscript: string): { valid: ValidClaim[]; rejected: { claim: ExtractedClaim; reason: string }[] } {
  const text = normalize(manuscript);
  const valid: ValidClaim[] = [];
  const rejected: { claim: ExtractedClaim; reason: string }[] = [];
  for (const claim of claims) {
    const parsed = parseNumber(claim.value_text);
    if (!parsed) rejected.push({ claim, reason: `"${claim.value_text}" is not a number` });
    else if (!text.includes(normalize(claim.value_text))) rejected.push({ claim, reason: `${claim.value_text} is not printed in the manuscript` });
    else if (!normalize(claim.quote).includes(normalize(claim.value_text))) rejected.push({ claim, reason: "quote does not contain the number" });
    else valid.push({ ...claim, value: parsed.value, decimals: parsed.decimals, tolerance: 10 ** -parsed.decimals });
  }
  return { valid, rejected };
}

/** Checks that every mapping points at an existing numeric column. */
export function validateMappings(claims: ValidClaim[], mappings: Mapping[], tables: Record<string, Record<string, string>[]>): string[] {
  const problems: string[] = [];
  for (const claim of claims) {
    const mapping = mappings.find((m) => m.claim_id === claim.id);
    if (!mapping) problems.push(`no output column for claim ${claim.id}`);
    else if (!tables[mapping.file]) problems.push(`claim ${claim.id}: output file ${mapping.file} does not exist`);
    else if (!tables[mapping.file]!.length || !(mapping.column in tables[mapping.file]![0]!)) problems.push(`claim ${claim.id}: column ${mapping.column} not in ${mapping.file}`);
  }
  return problems;
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export function compare(claims: ValidClaim[], mappings: Mapping[], tables: Record<string, Record<string, string>[]>): Comparison {
  const rows: CheckRow[] = [];
  const results: ClaimResult[] = [];
  for (const claim of claims) {
    const mapping = mappings.find((m) => m.claim_id === claim.id)!;
    const scale = 10 ** claim.decimals;
    const mine: CheckRow[] = [];
    for (const row of tables[mapping.file] ?? []) {
      const computed = Number(row[mapping.column]);
      const diff = Math.abs(computed - claim.value);
      mine.push({
        claim: claim.id,
        symbol: claim.symbol,
        file: mapping.file,
        dataset: row.dataset ?? "?",
        claimed: claim.value,
        computed,
        diff,
        tolerance: claim.tolerance,
        ok: Number.isFinite(computed) && diff < claim.tolerance,
        rounds: same(Math.round(computed * scale) / scale, claim.value),
        truncates: same(Math.trunc(computed * scale) / scale, claim.value),
      });
    }
    const values = mine.map((r) => r.computed);
    results.push({
      claim: claim.id,
      symbol: claim.symbol,
      claimed: claim.value_text,
      matched: mine.filter((r) => r.ok).length,
      total: mine.length,
      range: [Math.min(...values), Math.max(...values)],
    });
    rows.push(...mine);
  }
  const passed = rows.filter((r) => r.ok).length;
  const verdict: Verdict =
    rows.length > 0 && passed === rows.length ? "REPRODUCED"
    : rows.length === 0 || results.some((c) => c.matched === 0) ? "NOT REPRODUCED"
    : "PARTIAL";
  return {
    verdict,
    rows,
    claims: results,
    passed,
    total: rows.length,
    rounding: rows.filter((r) => r.rounds).length,
    truncation: rows.filter((r) => r.truncates).length,
    rule: VERDICT_RULE,
  };
}
