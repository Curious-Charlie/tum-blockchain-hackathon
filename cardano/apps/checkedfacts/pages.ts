/**
 * Fetches web pages as plain text, with a disk cache per agent
 * (cardano/.cache/pages/<agent>/), so reruns and live demos see the same page.
 * REFETCH=1 bypasses the cache.
 *
 * A page that cannot be fetched (network error, HTTP error, bot wall, PDF,
 * almost no text) is returned with `ok: false`. The checker counts such a
 * claim as "unverifiable", never as "fabricated".
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "@agentic/core";

export interface Page {
  url: string;
  ok: boolean;
  status?: number;
  title?: string;
  text: string;
  error?: string;
  fetchedAt: string;
}

const MIN_TEXT = 200;
const MAX_BYTES = 4_000_000;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,de;q=0.8",
};

const cacheFile = (agent: string, url: string) =>
  path.join(ROOT, ".cache", "pages", agent, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.json`);

/** Fetches `url` as text for `agent` (each agent has its own cache: they fetch independently). */
export async function fetchPage(url: string, agent: string): Promise<Page> {
  const file = cacheFile(agent, url);
  if (process.env.REFETCH !== "1" && existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Page;
  const page = await download(url);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(page));
  return page;
}

async function download(url: string): Promise<Page> {
  const fetchedAt = new Date().toISOString();
  const fail = (error: string, status?: number): Page => ({ url, ok: false, status, text: "", error, fetchedAt });
  if (!/^https?:\/\//i.test(url)) return fail("not an http(s) URL");
  try {
    const response = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return fail(`HTTP ${response.status}`, response.status);
    const type = response.headers.get("content-type") ?? "";
    if (!/html|text\/plain|xml/i.test(type)) return fail(`unsupported content type ${type || "unknown"}`, response.status);
    const raw = (await response.text()).slice(0, MAX_BYTES);
    const { title, text } = /html|xml/i.test(type) ? htmlToText(raw) : { title: undefined, text: raw.trim() };
    if (text.length < MIN_TEXT) return fail(`page has almost no text (${text.length} chars; bot wall or JavaScript-only page)`, response.status);
    return { url, ok: true, status: response.status, title, text, fetchedAt };
  } catch (error) {
    return fail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

// ---------------------------------------------------------------- HTML → text

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„", laquo: "«", raquo: "»", euro: "€",
  copy: "©", reg: "®", trade: "™", deg: "°", middot: "·", bull: "•", times: "×", szlig: "ß",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", eacute: "é", egrave: "è", agrave: "à", aacute: "á",
  ccedil: "ç", ntilde: "ñ", oacute: "ó", iacute: "í", uacute: "ú", ecirc: "ê", acirc: "â", ocirc: "ô",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const point = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : match;
    }
    return NAMED[code] ?? NAMED[code.toLowerCase()] ?? match;
  });
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"))?.slice(2).find(Boolean);

/** Visible text of an HTML page, plus its title and meta description. */
export function htmlToText(html: string): { title?: string; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => /(name|property)\s*=\s*["'](description|og:description)["']/i.test(tag))
    .map((tag) => attr(tag, "content") ?? "");
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|li|ul|ol|h[1-6]|tr|td|th|table|header|footer|nav|main|aside|blockquote|figure|figcaption|dd|dt)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const clean = (s: string) => decodeEntities(s).replace(/[ \t\f\v ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
  const text = [title, ...new Set(metas)].filter(Boolean).map((s) => clean(s!)).join("\n") + "\n" + clean(body);
  return { title: title ? clean(title) : undefined, text: text.trim() };
}

// ---------------------------------------------------------------- quote matching (deterministic)

const QUOTE_CHARS: Record<string, string> = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "‟": '"' };

/**
 * Lowercase letters and digits only, words separated by one space; `map[i]` is
 * the index in `text` of normalized character i. Punctuation, quotes, dashes,
 * case and whitespace differences therefore never decide a match.
 */
export function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let index = 0;
  for (const char of text) {
    const folded = (QUOTE_CHARS[char] ?? char).normalize("NFKC").toLowerCase();
    for (const c of folded) {
      if (/[\p{L}\p{N}]/u.test(c)) {
        norm += c;
        map.push(index);
      } else if (norm.length && !norm.endsWith(" ")) {
        norm += " ";
        map.push(index);
      }
    }
    index += char.length;
  }
  if (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

export const normalize = (text: string) => normalizeWithMap(text).norm;

/** Quotes shorter than this many words prove nothing and fail the check. */
export const MIN_QUOTE_WORDS = 6;

export type QuoteMatch =
  | { found: true; context: string }
  | { found: false; reason: string };

/**
 * Is `quote` really on the page? Exact match after normalization. A quote with
 * an ellipsis ("…" or "...") must have every part (each ≥ 4 words) on the page,
 * in order. Returns the surrounding page text for the support judgement.
 */
export function findQuote(quote: string, pageText: string): QuoteMatch {
  const words = normalize(quote).split(" ").filter(Boolean);
  if (words.length < MIN_QUOTE_WORDS) return { found: false, reason: `quote has ${words.length} words; at least ${MIN_QUOTE_WORDS} are required` };
  const parts = quote.split(/…|\.\.\./).map(normalize).filter(Boolean);
  if (parts.some((part) => part.split(" ").length < 4)) return { found: false, reason: "a part of the quote around an ellipsis is shorter than 4 words" };
  const page = normalizeWithMap(pageText);
  const haystack = ` ${page.norm} `;
  let from = 0;
  let start = -1;
  let end = -1;
  for (const part of parts) {
    const at = haystack.indexOf(` ${part} `, from);
    if (at < 0) return { found: false, reason: "quote not found on the source page" };
    if (start < 0) start = at;
    end = at + part.length;
    from = end;
  }
  const first = page.map[start] ?? 0;
  const last = page.map[Math.min(end, page.map.length - 1)] ?? pageText.length;
  const context = pageText.slice(Math.max(0, first - 600), Math.min(pageText.length, last + 600));
  return { found: true, context };
}
