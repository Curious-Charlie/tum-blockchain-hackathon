/**
 * Lena's finance agent.
 *
 * - AI interprets: Claude (Haiku) turns Lena's sentence into a structured order.
 *   Plain code then validates every field and looks the supplier up in Lena's
 *   own address book; the LLM never chooses an address or moves money.
 * - Lena's treasury locks the invoice in the escrow (EVM).
 * - Buyer: for each invoice the agent asks every Keeper for a price, checks
 *   each Keeper's record on chain (records.ts) and chooses in code
 *   (`chooseKeeper`). It then locks the chosen Keeper's fee in Masumi escrow
 *   (`hire`), follows the job and withdraws a refund if the Keeper gives up.
 * - Or, with --x402, it hires the Keeper per attempt; a failed attempt costs nothing.
 * - Every payment goes through AgentGuard: payee allowlist = the Keepers,
 *   per-payment, per-invoice and daily caps, audit log, kill switch.
 */
import { AgentGuard, ESCROW, HAIKU, PaymentBlocked, TUSDM, ada, askJson, emit, formatAmount, limits, sleep, usdm, type Wallet } from "@agentic/core";
import { escrowOutputOf, record, withdrawRefund, type EscrowJob } from "@agentic/core/escrow";
import { choose, getQuote, settlementTx, type Provider, type Quote } from "@agentic/core/market";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { ESCROW_NODE, showRate, toRate, usd, type Evm } from "./evm.ts";
import type { WatchRequest } from "./keeper.ts";
import { keeperRecord, recordText, verifyBinding, type KeeperRecord } from "./records.ts";

/** Lena's suppliers. The order's payee comes from here, never from the model. */
const supplier = (slug: string) => privateKeyToAddress(keccak256(stringToHex(`payonproof:supplier:${slug}`)));
export const ADDRESS_BOOK: Record<string, { name: string; address: Address }> = {
  cafeverde: { name: "Café Verde (Colombia)", address: supplier("cafe-verde") },
  fazendaalta: { name: "Fazenda Alta (Brazil)", address: supplier("fazenda-alta") },
};

export interface ParsedOrder {
  invoiceRef: string;
  payee: string;
  amountEur: number;
  maxRate: number;
  deadline: string;
}

const ORDER_SCHEMA = {
  type: "object",
  properties: {
    invoiceRef: { type: "string", description: "Invoice reference such as INV-17" },
    payee: { type: "string", description: "Supplier name exactly as written" },
    amountEur: { type: "number", description: "Invoice amount in euros" },
    maxRate: { type: "number", description: "EUR/USD limit: pay only while the rate is below this number" },
    deadline: { type: "string", description: "Last day to pay, YYYY-MM-DD" },
  },
  required: ["invoiceRef", "payee", "amountEur", "maxRate", "deadline"],
  additionalProperties: false,
} as const;

const normalize = (text: string) => text.normalize("NFD").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

/** A Keeper needs this many verified executions on chain before it gets invoices above the trial size. */
export const MIN_VERIFIED = 2;
export const TRIAL_MAX_EUR_CENTS = 250_00n;

export interface Hired {
  jobId: string;
  keeper: Quote;
  lockTx?: string;
}

export class LenaAgent {
  readonly guard: AgentGuard;

  constructor(readonly wallet: Wallet, readonly evm: Evm, readonly keepers: Provider[]) {
    this.guard = new AgentGuard(wallet, {
      maxPerPayment: limits(ada(2), usdm(3)),
      maxPerTask: limits(ada(2), usdm(3)), // a Keeper can earn one fee per invoice
      maxPerDay: limits(ada(30), usdm(30)),
      payees: Object.fromEntries(keepers.map((k) => [k.address, k.name])),
    });
  }

  private step(message: string, task?: string, data?: Record<string, unknown>) {
    emit({ kind: "task.step", actor: this.wallet.name, task, message, data });
  }

  /** Claude reads the instruction; code checks the result. */
  async interpret(instruction: string): Promise<ParsedOrder> {
    const today = new Date().toISOString().slice(0, 10);
    let parsed: ParsedOrder;
    try {
      parsed = await askJson<ParsedOrder>({
        model: HAIKU,
        system: `You turn a small business owner's payment instruction into a structured order. Today is ${today}. Copy values exactly as written; never invent missing ones. Dates without a year are the next such date.`,
        prompt: instruction,
        schema: ORDER_SCHEMA,
      });
    } catch (error) {
      this.step(`Claude unavailable (${(error instanceof Error ? error.message : String(error)).slice(0, 60)}); falling back to rule-based parsing`);
      parsed = parseWithRules(instruction, today);
    }
    return parsed;
  }

  /** Deterministic validation of what the model returned. Throws on anything off. */
  validate(parsed: ParsedOrder) {
    const entry = Object.entries(ADDRESS_BOOK).find(([key]) => normalize(parsed.payee).includes(key));
    if (!entry) throw new Error(`"${parsed.payee}" is not in Lena's address book`);
    if (!/^[A-Za-z0-9-]{1,31}$/.test(parsed.invoiceRef)) throw new Error(`Bad invoice reference "${parsed.invoiceRef}"`);
    if (!(parsed.amountEur >= 1 && parsed.amountEur <= 50_000)) throw new Error(`Amount €${parsed.amountEur} is outside €1–50,000`);
    if (!(parsed.maxRate > 0.8 && parsed.maxRate < 1.6)) throw new Error(`EUR/USD limit ${parsed.maxRate} is implausible`);
    const deadline = Date.parse(`${parsed.deadline}T23:59:59Z`);
    if (!(deadline > Date.now() && deadline < Date.now() + 120 * 86_400_000)) throw new Error(`Deadline ${parsed.deadline} is not within the next 120 days`);
    return {
      invoiceRef: parsed.invoiceRef,
      payee: entry[1],
      amountEurCents: BigInt(Math.round(parsed.amountEur * 100)),
      maxRate: toRate(parsed.maxRate),
      deadline: BigInt(Math.floor(deadline / 1000)),
    };
  }

  /** Instruction → validated order → invoice locked in the escrow. */
  async place(instruction: string) {
    this.step(`Lena: "${instruction}"`);
    const parsed = await this.interpret(instruction);
    const order = this.validate(parsed);
    const euros = `€${(Number(order.amountEurCents) / 100).toLocaleString("en-US")}`;
    this.step(`Claude read it as ${parsed.invoiceRef}: ${euros} to ${order.payee.name} when EUR/USD < ${parsed.maxRate}, by ${parsed.deadline}; checked against Lena's address book and limits`, parsed.invoiceRef, { parsed });
    const created = await this.evm.createOrder({ ...order, payee: order.payee.address });
    const ref = this.evm.txRef(created.hash);
    emit({
      kind: "payment.external", actor: this.wallet.name, task: parsed.invoiceRef, from: this.wallet.name, to: ESCROW_NODE, amount: usd(created.deposit), link: ref.link, linkLabel: ref.link ? "basescan ↗" : undefined,
      message: `Locked ${usd(created.deposit)} (${euros} at ${showRate(order.maxRate)}) in the escrow as order ${created.orderId}, payable only to ${order.payee.name}; the Keeper can trigger it but never redirect it${ref.note}`,
      data: { evmTx: created.hash, orderId: String(created.orderId) },
    });
    return { ...order, orderId: created.orderId, euros };
  }

  /**
   * One paid attempt: "execute order N if its condition holds". The signed fee
   * settles only if the Keeper answers 200.
   */
  async attempt(orderId: bigint, task: string, keeperUrl = this.keepers[0]!.url): Promise<{ status: string; body: Record<string, unknown> }> {
    try {
      const response = await this.guard.fetch(`${keeperUrl}/orders/${orderId}/execute`, { method: "POST" }, { task, purpose: `an execution attempt on ${task}` });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: String(body.status ?? response.status), body };
    } catch (error) {
      if (error instanceof PaymentBlocked) return { status: "blocked", body: { reason: error.reason } };
      throw error;
    }
  }

  /**
   * Buyer decision, all in code: each Keeper's price (its x402 quote), its proof
   * of which EVM account it executes from, and its record on chain. The cheapest
   * acceptable Keeper wins; ties go to the better record.
   */
  async chooseKeeper(order: { orderId: bigint; invoiceRef: string; amountEurCents: bigint }, task: string, watchMinutes: number): Promise<Quote | undefined> {
    const body: WatchRequest = { task, watchMinutes };
    this.step(`Asking ${this.keepers.length} Keepers for a price to watch ${order.invoiceRef}, and reading their records on Cardano and ${this.evm.name}…`, task);
    const quotes = await Promise.all(this.keepers.map((k) => getQuote(k, `/orders/${order.orderId}/watch`, body).catch(() => undefined)));
    const records = new Map<string, KeeperRecord & { bound: boolean }>();
    await Promise.all(this.keepers.map(async (k) => {
      const profile = await fetch(`${k.url}/profile`).then((r) => r.json() as Promise<{ cardano: string; evm: Address; binding: Hex }>).catch(() => undefined);
      const bound = Boolean(profile && profile.cardano === k.address && (await verifyBinding(k.address, profile.evm, profile.binding)));
      records.set(k.role, { ...(await keeperRecord({ address: k.address, evmAddress: bound ? profile!.evm : undefined }, this.evm)), bound });
    }));
    const cap = this.guard.policy.maxPerPayment[TUSDM] ?? 0n;
    const left = (this.guard.policy.maxPerTask[TUSDM] ?? 0n) - (this.guard.state(task).spentOnTask[TUSDM] ?? 0n);
    const trial = `€${Number(TRIAL_MAX_EUR_CENTS) / 100}`;
    const { chosen, assessments } = choose(quotes, {
      asset: TUSDM,
      maxAmount: cap < left ? cap : left,
      record: (q) => recordText(records.get(q.role)!),
      check: (q) => {
        const r = records.get(q.role)!;
        if (!q.escrow) return "its quote does not lock the fee in escrow";
        if (!r.bound) return "its profile does not prove which EVM account it executes from";
        if (r.falseReceipts) return `${r.falseReceipts} of its receipts name executions that ${this.evm.name} does not show`;
        if (r.verified < MIN_VERIFIED && order.amountEurCents > TRIAL_MAX_EUR_CENTS) return `new Keepers get invoices up to ${trial} until they have ${MIN_VERIFIED} verified executions`;
        return undefined;
      },
      rank: (a, b) => records.get(b.role)!.verified - records.get(a.role)!.verified,
    });
    for (const a of assessments) this.step(`${a.chosen ? "✓" : "✗"} ${a.name}: ${a.price}, ${a.record} → ${a.chosen ? "CHOSEN" : "not chosen"}: ${a.why}`, task);
    if (!chosen) {
      this.step(`No Keeper is acceptable for ${order.invoiceRef}; nothing is locked`, task, { assessments });
      return undefined;
    }
    this.step(`Buyer decision: hire ${chosen.name} for ${formatAmount(chosen.asset, chosen.amount)} to watch ${order.invoiceRef} (AgentGuard cap ${formatAmount(TUSDM, cap)} per payment and per invoice); the fee is locked in Masumi escrow until it delivers`, task, { assessments });
    return chosen;
  }

  /** Locks the Keeper's fee in Masumi escrow; the Keeper starts watching once the lock is on chain. */
  async hire(orderId: bigint, keeper: Quote, task: string, watchMinutes: number): Promise<Hired | undefined> {
    const body: WatchRequest = { task, watchMinutes };
    try {
      const response = await this.guard.fetch(`${keeper.url}/orders/${orderId}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { task, purpose: `watching ${task}` });
      if (response.status !== 202) {
        this.step(`${keeper.name} answered HTTP ${response.status}: no lock was made`, task);
        return undefined;
      }
      const { jobId } = (await response.json()) as { jobId: string };
      return { jobId, keeper, lockTx: settlementTx(response.headers.get("PAYMENT-RESPONSE")) };
    } catch (error) {
      if (error instanceof PaymentBlocked) {
        this.step(`AgentGuard blocked the lock: ${error.reason}`, task);
        return undefined;
      }
      throw error;
    }
  }

  /** Follows a hired job (local HTTP, no chain calls) until the Keeper delivers, gives up or vanishes. */
  async follow(hired: Hired, timeoutMs: number): Promise<EscrowJob | undefined> {
    const deadline = Date.now() + timeoutMs;
    let job: EscrowJob | undefined;
    while (Date.now() < deadline) {
      job = await fetch(`${hired.keeper.url}/jobs/${hired.jobId}`).then((r) => (r.ok ? (r.json() as Promise<EscrowJob>) : undefined)).catch(() => undefined);
      if (job && ["result_submitted", "refund_authorized", "vanished", "failed"].includes(job.status)) return job;
      await sleep(5_000);
    }
    return job;
  }

  /** Takes the fee back from the escrow: at once after the Keeper authorized it, otherwise after the result deadline. */
  async refund(job: EscrowJob, why: string): Promise<string> {
    const utxo = await escrowOutputOf(this.wallet, job.escrowTx!);
    if (!utxo) throw new Error(`no escrow output in ${job.escrowTx}`);
    const tx = await withdrawRefund(this.wallet, utxo);
    job.status = "refunded";
    record(job, "withdraw_refund", tx);
    emit({ kind: "payment.settled", actor: this.wallet.name, task: job.task, from: ESCROW, to: this.wallet.name, amount: job.amount, tx, message: `${this.wallet.name} took its ${job.amount} back from the escrow: ${why}` });
    return tx;
  }
}

/** Used only if Claude is unreachable, so the demo still runs. */
function parseWithRules(text: string, today: string): ParsedOrder {
  const invoiceRef = text.match(/INV-\d+/i)?.[0] ?? "INV-0";
  const amountEur = Number(text.match(/€\s?([\d,.]+)/)?.[1]?.replace(/,/g, "") ?? NaN);
  const maxRate = Number(text.match(/(?:below|under)\s+(\d\.\d+)/i)?.[1] ?? NaN);
  const payee = Object.values(ADDRESS_BOOK).find((s) => normalize(text).includes(normalize(s.name.split(" (")[0])))?.name ?? "unknown";
  const month = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
  let deadline = today;
  if (month) {
    const year = Number(today.slice(0, 4));
    const candidate = new Date(`${month[1]} ${month[2]}, ${year} UTC`);
    if (candidate.getTime() < Date.parse(today)) candidate.setUTCFullYear(year + 1);
    deadline = candidate.toISOString().slice(0, 10);
  }
  return { invoiceRef, payee, amountEur, maxRate, deadline };
}
