/**
 * Small chain helpers for this app (kept out of core on purpose).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { onEvent, type Wallet } from "@agentic/core";

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

const STATE_DIR = fileURLToPath(new URL("../.state/", import.meta.url));
const PENDING = path.join(STATE_DIR, "last-tx.json");

/**
 * Core waits for a wallet's previous transaction before spending again, but only
 * within one process. This remembers each paying wallet's last transaction on
 * disk, so a demo started right after the previous one does not reuse a UTxO
 * that is still in the mempool.
 */
export function rememberLastTx(wallets: Wallet[]) {
  const saved: Record<string, string> = existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, "utf8")) : {};
  for (const wallet of wallets) if (saved[wallet.role]) wallet.submitted(saved[wallet.role]!);
  onEvent((event) => {
    if (!event.tx || (event.kind !== "payment.settled" && event.kind !== "chain.published")) return;
    const payer = event.kind === "payment.settled" ? event.from : event.actor;
    const wallet = wallets.find((w) => w.name === payer);
    if (!wallet) return;
    saved[wallet.role] = event.tx;
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(PENDING, JSON.stringify(saved, null, 2));
  });
}
