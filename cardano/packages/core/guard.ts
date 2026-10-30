/**
 * D4 AgentGuard: the only way our agents pay. `guard.fetch(url)` replaces
 * `fetch`; on HTTP 402 it checks the spend policy, then signs and pays.
 *
 * - per-payment cap, per-task budget and daily budget, per asset (fail closed:
 *   an asset without a cap cannot be paid)
 * - payee allowlist, so a prompt injection cannot redirect money
 * - JSONL audit log of every approved, blocked, settled and voided payment
 * - kill switch: `guard.freeze()` for one agent, or the FREEZE file
 *   (`npm run freeze`, dashboard button) for every agent on this machine
 *
 * Budgets count settled payments only. A payment the seller voids (its work
 * failed, so x402 never submits the transaction) is released again.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { NETWORK, ROOT, formatAmount, shortAddress, symbolOf, type Amount } from "./config.ts";
import { appName, emit } from "./events.ts";
import type { Wallet } from "./wallets.ts";

/** Asset unit → limit in smallest units. */
export type Limits = Partial<Record<string, bigint>>;

export const limits = (...amounts: Amount[]): Limits => Object.fromEntries(amounts.map((a) => [a.asset, a.amount]));

export interface GuardPolicy {
  /** Largest single payment per asset. Assets missing here cannot be paid. */
  maxPerPayment: Limits;
  /** Budget per task id, per asset. */
  maxPerTask: Limits;
  /** Budget per UTC day, per asset. */
  maxPerDay: Limits;
  /** Allowed payees: address → display name. */
  payees: Record<string, string>;
}

export type GuardRule = "frozen" | "payee" | "asset" | "per_payment" | "per_task" | "per_day";
export type Verdict = { ok: true } | { ok: false; rule: GuardRule; reason: string };

export interface PaymentIntent {
  payTo: string;
  asset: string;
  amount: bigint;
}

export interface SpendState {
  frozen?: string;
  spentToday: Limits;
  spentOnTask: Limits;
}

/** The policy decision, kept pure so it can be unit tested. */
export function checkPayment(policy: GuardPolicy, state: SpendState, intent: PaymentIntent): Verdict {
  const fmt = (amount: bigint) => formatAmount(intent.asset, amount);
  if (state.frozen) return { ok: false, rule: "frozen", reason: `kill switch is on (${state.frozen})` };
  if (!(intent.payTo in policy.payees)) {
    return { ok: false, rule: "payee", reason: `payee ${shortAddress(intent.payTo)} is not on the allowlist` };
  }
  const cap = policy.maxPerPayment[intent.asset];
  if (cap === undefined) return { ok: false, rule: "asset", reason: `${symbolOf(intent.asset)} is not an allowed asset` };
  if (intent.amount > cap) {
    return { ok: false, rule: "per_payment", reason: `${fmt(intent.amount)} is over the per-payment cap of ${fmt(cap)}` };
  }
  const budgets: [GuardRule, string, bigint | undefined, bigint][] = [
    ["per_task", "task budget", policy.maxPerTask[intent.asset], state.spentOnTask[intent.asset] ?? 0n],
    ["per_day", "daily budget", policy.maxPerDay[intent.asset], state.spentToday[intent.asset] ?? 0n],
  ];
  for (const [rule, label, budget, spent] of budgets) {
    if (spent + intent.amount > (budget ?? 0n)) {
      return { ok: false, rule, reason: `${label} exceeded: ${fmt(spent)} spent + ${fmt(intent.amount)} > ${fmt(budget ?? 0n)}` };
    }
  }
  return { ok: true };
}

export class PaymentBlocked extends Error {
  constructor(readonly rule: GuardRule, readonly reason: string) {
    super(`AgentGuard blocked the payment: ${reason}`);
    this.name = "PaymentBlocked";
  }
}

export interface AuditEntry {
  ts: string;
  guard: string;
  task: string;
  decision: "approved" | "blocked" | "settled" | "voided" | "error";
  url: string;
  payTo?: string;
  payee?: string;
  asset?: string;
  amount?: string;
  rule?: GuardRule;
  reason?: string;
  status?: number;
  tx?: string;
}

export const AUDIT_DIR = path.join(ROOT, ".audit");
const FREEZE_FILE = path.join(AUDIT_DIR, "FREEZE");
const today = () => new Date().toISOString().slice(0, 10);

/** Machine-wide kill switch: every AgentGuard refuses to pay while the FREEZE file exists. */
export function freezeAll(reason = "frozen by operator") {
  mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileSync(FREEZE_FILE, reason);
}

export function unfreezeAll() {
  rmSync(FREEZE_FILE, { force: true });
}

export function frozenReason(): string | undefined {
  return existsSync(FREEZE_FILE) ? readFileSync(FREEZE_FILE, "utf8").trim() || "frozen" : undefined;
}

export class AgentGuard {
  private frozen?: string;
  private readonly spentByDay = new Map<string, Limits>();
  private readonly spentByTask = new Map<string, Limits>();
  readonly auditFile: string;

  constructor(readonly wallet: Wallet, readonly policy: GuardPolicy) {
    mkdirSync(AUDIT_DIR, { recursive: true });
    this.auditFile = path.join(AUDIT_DIR, `${appName()}-${wallet.role.toLowerCase()}.jsonl`);
    this.replay();
  }

  get name() {
    return this.wallet.name;
  }

  freeze(reason = "frozen by operator") {
    this.frozen = reason;
  }

  unfreeze() {
    this.frozen = undefined;
  }

  allowPayee(address: string, name: string) {
    this.policy.payees[address] = name;
  }

  state(task: string): SpendState {
    return {
      frozen: this.frozen ?? frozenReason(),
      spentToday: this.spentByDay.get(today()) ?? {},
      spentOnTask: this.spentByTask.get(task) ?? {},
    };
  }

  /** Settled spend so far today, formatted per asset. */
  spentToday(): string[] {
    return Object.entries(this.spentByDay.get(today()) ?? {}).map(([asset, amount]) => formatAmount(asset, amount ?? 0n));
  }

  /**
   * `fetch` that pays x402 requests within the policy. Throws `PaymentBlocked`
   * when the policy refuses. A response >= 400 means the seller voided the
   * payment and nothing was paid.
   */
  async fetch(input: string | URL, init: RequestInit = {}, meta: { task?: string; purpose?: string } = {}): Promise<Response> {
    const task = meta.task ?? "default";
    const url = String(input);
    return this.wallet.exclusive(async () => {
      let attempt: { intent: PaymentIntent; payee: string } | undefined;
      let blocked: { rule: GuardRule; reason: string } | undefined;

      const client = x402Client.fromConfig({
        schemes: [{ network: NETWORK, client: new ExactCardanoScheme(this.wallet.signer()) }],
        // AgentGuard enforces the caps; the SDK's own control only has to let our assets through.
        spendControls: { allowedAssets: Object.keys(this.policy.maxPerPayment).map((asset) => ({ network: NETWORK, asset })) },
      });
      client.onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
        const intent: PaymentIntent = { payTo: req.payTo, asset: req.asset, amount: BigInt(req.amount) };
        const payee = this.policy.payees[req.payTo] ?? shortAddress(req.payTo);
        const amount = formatAmount(intent.asset, intent.amount);
        const verdict = checkPayment(this.policy, this.state(task), intent);
        const base = { task, url, payTo: req.payTo, payee, asset: req.asset, amount: req.amount };
        if (!verdict.ok) {
          blocked = verdict;
          this.audit({ ...base, decision: "blocked", rule: verdict.rule, reason: verdict.reason });
          emit({ kind: "guard.blocked", actor: this.name, task, from: this.name, to: payee, amount, message: `AgentGuard BLOCKED ${amount} → ${payee}: ${verdict.reason}`, data: { rule: verdict.rule } });
          return { abort: true, reason: verdict.reason };
        }
        attempt = { intent, payee };
        this.add(task, intent, 1n);
        this.audit({ ...base, decision: "approved" });
        emit({ kind: "guard.approved", actor: this.name, task, from: this.name, to: payee, amount, message: `AgentGuard approved ${amount} → ${payee}${meta.purpose ? ` for ${meta.purpose}` : ""}` });
      });

      let response: Response;
      try {
        response = await wrapFetchWithPayment(fetch, client)(input, init);
      } catch (error) {
        if (blocked) throw new PaymentBlocked(blocked.rule, blocked.reason);
        if (attempt) {
          this.add(task, attempt.intent, -1n);
          this.audit({ task, url, decision: "error", payTo: attempt.intent.payTo, reason: String(error) });
        }
        throw error;
      }
      if (!attempt) return response;

      const { intent, payee } = attempt;
      const amount = formatAmount(intent.asset, intent.amount);
      const base = { task, url, payTo: intent.payTo, payee, asset: intent.asset, amount: String(intent.amount), status: response.status };
      const header = response.headers.get("PAYMENT-RESPONSE");
      const settlement = header ? decodePaymentResponseHeader(header) : undefined;
      if (response.ok && settlement?.success && settlement.transaction) {
        this.wallet.submitted(settlement.transaction);
        this.audit({ ...base, decision: "settled", tx: settlement.transaction });
        emit({ kind: "payment.settled", actor: this.name, task, from: this.name, to: payee, amount, tx: settlement.transaction, message: `${this.name} paid ${amount} → ${payee}` });
      } else {
        this.add(task, intent, -1n);
        this.audit({ ...base, decision: "voided" });
        emit({ kind: "payment.voided", actor: this.name, task, from: this.name, to: payee, amount, message: `${payee} answered HTTP ${response.status}: the signed ${amount} was never submitted, nothing paid`, data: { status: response.status } });
      }
      return response;
    });
  }

  private add(task: string, intent: PaymentIntent, sign: 1n | -1n) {
    for (const [map, key] of [[this.spentByDay, today()], [this.spentByTask, task]] as const) {
      const entry = map.get(key) ?? {};
      entry[intent.asset] = (entry[intent.asset] ?? 0n) + sign * intent.amount;
      map.set(key, entry);
    }
  }

  private audit(entry: Omit<AuditEntry, "ts" | "guard">) {
    appendFileSync(this.auditFile, `${JSON.stringify({ ts: new Date().toISOString(), guard: this.name, ...entry })}\n`);
  }

  /** Rebuilds budgets from today's settled payments in the audit log. */
  private replay() {
    if (!existsSync(this.auditFile)) return;
    for (const line of readFileSync(this.auditFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as AuditEntry;
      if (entry.decision !== "settled" || !entry.ts.startsWith(today()) || !entry.asset || !entry.amount || !entry.payTo) continue;
      this.add(entry.task, { payTo: entry.payTo, asset: entry.asset, amount: BigInt(entry.amount) }, 1n);
    }
  }
}
