/**
 * x402 seller kit: an express app whose paid routes charge in tADA or tUSDM
 * through an in-process facilitator (no separate service).
 *
 * Settle only on success: when a paid handler answers with status >= 400,
 * @x402/express cancels settlement and the buyer's signed transaction is never
 * submitted. Every design relies on this.
 *
 *   const seller = new Seller(wallet);
 *   seller.paid("POST /check", { price: usdm(0.5), description: "Fact-check a batch" }, handler);
 *   const { url } = await seller.listen(4101);
 *
 * With `escrow: true` a route is paid into Masumi's escrow contract instead of
 * to the seller: the buyer locks the price (x402 `assetTransferMethod:
 * "masumi"`), the seller signs the terms, and collects later on chain after it
 * has submitted a result hash. The seller wallet must be able to sign terms.
 */
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, type FacilitatorClient, type HTTPRequestContext, type HTTPTransportContext, type RouteConfig } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { paymentMiddleware } from "@x402/express";
import { masumiEscrowAddress, toFacilitatorCardanoSigner, type MasumiDeadlineOffsets, type MasumiSellerSigner } from "@x402/cardano";
import { ExactCardanoScheme as ServerScheme } from "@x402/cardano/exact/server";
import { ExactCardanoScheme as FacilitatorScheme } from "@x402/cardano/exact/facilitator";
import { NETWORK, formatAmount, fromUnit, provider, shortAddress, type Amount } from "./config.ts";
import { emit } from "./events.ts";

export type Price = Amount | ((context: HTTPRequestContext) => Amount | Promise<Amount>);
type RouteKey = `${"GET" | "POST"} /${string}`;

/**
 * Masumi deadlines relative to the pay-by time (5 min after the quote): result
 * hash due 17 min after the quote, seller may collect from 32 min, dispute window
 * ends at 47 min. These are the shortest the Masumi rules allow (submit ≥ quote +
 * 15 min, unlock ≥ submit + 15 min, dispute end ≥ unlock + 15 min), plus margin.
 */
export const ESCROW_DEADLINES: Required<MasumiDeadlineOffsets> = {
  submitResultAfterPayByMs: 12 * 60_000,
  unlockAfterPayByMs: 27 * 60_000,
  externalDisputeUnlockAfterPayByMs: 42 * 60_000,
};

let sharedFacilitator: FacilitatorClient | undefined;

/** One in-process facilitator per process; it verifies and submits buyers' signed transactions. */
function facilitator(): FacilitatorClient {
  if (sharedFacilitator) return sharedFacilitator;
  const inner = new x402Facilitator().register(NETWORK,
    // With Blockfrost the SDK cannot wait for confirmation itself; we return as soon as the tx is submitted.
    new FacilitatorScheme(toFacilitatorCardanoSigner({ network: NETWORK, provider: provider(), awaitConfirmation: false }), { confirmationTimeoutMs: 180_000 }),
  );
  sharedFacilitator = {
    verify: (payload, requirements) => inner.verify(payload, requirements),
    settle: async (payload, requirements) => {
      const result = await inner.settle(payload, requirements);
      if (!result.success) console.error("Settlement failed:", JSON.stringify(result));
      return result;
    },
    getSupported: async () => inner.getSupported() as Awaited<ReturnType<FacilitatorClient["getSupported"]>>,
  };
  return sharedFacilitator;
}

const toPrice = ({ asset, amount }: Amount) => ({ asset: fromUnit(asset), amount: amount.toString() });

/** A payment that settled on chain, with the request it paid for. */
export interface Settled {
  tx: string;
  payer?: string;
  asset: string;
  amount: bigint;
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  /** The paid handler's response body, parsed as JSON when possible. */
  body?: unknown;
  /** The settled payment requirements; for escrow routes `extra.terms` holds the signed Masumi terms. */
  requirements: PaymentRequirements;
}

export class Seller {
  readonly app = express();
  private readonly routes: Record<string, RouteConfig> = {};
  private middleware?: RequestHandler;
  private readonly settledListeners: ((settled: Settled) => unknown)[] = [];

  private escrowRoutes = 0;

  constructor(readonly wallet: { name: string; address: string; masumiSeller?: () => MasumiSellerSigner }) {
    this.app.use(express.json({ limit: "5mb" }));
    // Installed first so it guards every paid route; built in listen() once all routes are known.
    this.app.use((req, res, next) => (this.middleware ? this.middleware(req, res, next) : next()));
  }

  /**
   * Registers a paid route. The handler runs only after the payment is verified.
   * `escrow: true` makes the buyer lock the price in Masumi's escrow (see above).
   */
  paid(route: RouteKey, options: { price: Price; description: string; escrow?: boolean }, handler: RequestHandler): this {
    const { price, escrow } = options;
    if (escrow) {
      if (!this.wallet.masumiSeller) throw new Error(`${this.wallet.name} cannot sign Masumi terms: pass a Wallet to Seller`);
      this.escrowRoutes++;
    }
    this.routes[route] = {
      accepts: {
        scheme: "exact",
        network: NETWORK,
        payTo: escrow ? masumiEscrowAddress(NETWORK) : this.wallet.address,
        price: typeof price === "function" ? async (context) => toPrice(await price(context)) : toPrice(price),
        // An escrow quote's pay-by time is the quote time plus this; the deadlines count from it.
        maxTimeoutSeconds: escrow ? 300 : 600,
        extra: escrow
          ? { assetTransferMethod: "masumi", areFeesSponsored: false }
          : { assetTransferMethod: "default", areFeesSponsored: false, confirmationPolicy: { l1Confirmations: 0 } },
      },
      description: options.description,
      mimeType: "application/json",
    };
    const [method, path] = route.split(" ") as ["GET" | "POST", string];
    if (method === "GET") this.app.get(path, handler);
    else this.app.post(path, handler);
    return this;
  }

  /**
   * Runs `listener` after each payment settles (tx submitted). It runs in the
   * background, so slow work such as publishing a receipt does not delay the buyer.
   */
  onSettled(listener: (settled: Settled) => unknown): this {
    this.settledListeners.push(listener);
    return this;
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<{ url: string; close: () => Promise<void> }> {
    const scheme = this.escrowRoutes
      ? new ServerScheme({
          masumi: {
            seller: this.wallet.masumiSeller!(),
            deadlines: ESCROW_DEADLINES,
            // The escrow's input_hash commits to the request body the buyer pays for.
            commitment: ({ transportContext }) => [{
              name: "body",
              canonicalization: "jcs",
              mediaType: "application/json",
              content: (transportContext as HTTPTransportContext | undefined)?.request.adapter.getBody?.() ?? {},
            }],
          },
        })
      : new ServerScheme();
    const server = new x402ResourceServer(facilitator()).register(NETWORK, scheme);
    server.onAfterVerify(async ({ requirements, result }) => {
      const amount = formatAmount(requirements.asset, requirements.amount);
      const escrow = requirements.extra?.assetTransferMethod === "masumi";
      emit(result.isValid
        ? {
            kind: "payment.held",
            actor: this.wallet.name,
            message: escrow
              ? `${this.wallet.name} verified a signed ${amount} lock into Masumi escrow${result.payer ? ` from ${shortAddress(result.payer)}` : ""}; it goes on chain once the job is accepted`
              : `${this.wallet.name} verified a signed ${amount} payment${result.payer ? ` from ${shortAddress(result.payer)}` : ""}; it is held until the work succeeds`,
            data: { payer: result.payer },
          }
        : {
            kind: "task.step",
            actor: this.wallet.name,
            message: `${this.wallet.name} rejected a signed ${amount} payment (${result.invalidReason ?? "invalid"}); nothing was paid`,
            data: { payer: result.payer, reason: result.invalidReason },
          });
    });
    server.onAfterSettle(async ({ requirements, result, transportContext }) => {
      if (!result.success || !result.transaction || !this.settledListeners.length) return;
      const transport = transportContext as { request?: HTTPRequestContext; responseBody?: Buffer } | undefined;
      let body: unknown;
      try {
        body = transport?.responseBody?.length ? JSON.parse(transport.responseBody.toString("utf8")) : undefined;
      } catch {
        body = transport?.responseBody?.toString("utf8");
      }
      const settled: Settled = {
        tx: result.transaction,
        payer: result.payer,
        asset: requirements.asset,
        amount: BigInt(requirements.amount),
        method: transport?.request?.method ?? "",
        path: transport?.request?.path ?? "",
        query: transport?.request?.adapter.getQueryParams?.() ?? {},
        body,
        requirements: requirements as PaymentRequirements,
      };
      for (const listener of this.settledListeners) {
        void Promise.resolve()
          .then(() => listener(settled))
          .catch((error) => console.error(`onSettled listener failed: ${String(error)}`));
      }
    });
    this.middleware = paymentMiddleware(this.routes, server);
    const listener = this.app.listen(port, host);
    await new Promise((resolve, reject) => listener.once("listening", resolve).once("error", reject));
    const url = `http://${host}:${(listener.address() as AddressInfo).port}`;
    return { url, close: () => new Promise((resolve) => listener.close(() => resolve())) };
  }
}
