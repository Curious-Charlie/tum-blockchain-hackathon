/**
 * Small chain helpers for this app (kept out of core on purpose).
 */

/** Transaction hash from an x402 PAYMENT-RESPONSE header (base64 JSON), if it settled. */
export function settlementTx(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  try {
    const settlement = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { success?: boolean; transaction?: string };
    return settlement.success ? settlement.transaction : undefined;
  } catch {
    return undefined;
  }
}

/** Wraps text at spaces into lines of at most `max` UTF-8 bytes (CIP-20); longer words are split by core. */
export function wrapWords(texts: string[], max = 64): string[] {
  const lines: string[] = [];
  for (const text of texts) {
    let line = "";
    for (const word of text.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (Buffer.byteLength(next) <= max || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}
