/**
 * Lena's finance agent.
 *
 * - AI interprets: Claude (Haiku) turns Lena's sentence into a structured order.
 *   Plain code then validates every field and looks the supplier up in Lena's
 *   own address book; the LLM never chooses an address or moves money.
 * - Lena's treasury locks the invoice in the escrow (EVM).
 * - The agent hires the Keeper per attempt over x402, paying only through
 *   AgentGuard (payee allowlist = the Keeper, per-payment, per-invoice and
 *   daily caps). A failed attempt costs nothing.
 */
import { AgentGuard, HAIKU, PaymentBlocked, ada, askJson, emit, limits, type Wallet } from "@agentic/core";
import { keccak256, stringToHex, type Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { ESCROW_NODE, showRate, toRate, usd, type Evm } from "./evm.ts";

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

export class LenaAgent {
  readonly guard: AgentGuard;

  constructor(readonly wallet: Wallet, readonly evm: Evm, readonly keeper: { url: string; wallet: Wallet }) {
    this.guard = new AgentGuard(wallet, {
      maxPerPayment: limits(ada(2)),
      maxPerTask: limits(ada(2)), // the Keeper can earn one fee per invoice
      maxPerDay: limits(ada(30)),
      payees: { [keeper.wallet.address]: keeper.wallet.name },
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
  async attempt(orderId: bigint, task: string, keeperUrl = this.keeper.url): Promise<{ status: string; body: Record<string, unknown> }> {
    try {
      const response = await this.guard.fetch(`${keeperUrl}/orders/${orderId}/execute`, { method: "POST" }, { task, purpose: `an execution attempt on ${task}` });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: String(body.status ?? response.status), body };
    } catch (error) {
      if (error instanceof PaymentBlocked) return { status: "blocked", body: { reason: error.reason } };
      throw error;
    }
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
