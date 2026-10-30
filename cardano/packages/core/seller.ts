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
 */
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, type FacilitatorClient, type HTTPRequestContext, type RouteConfig } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme as ServerScheme } from "@x402/cardano/exact/server";
import { ExactCardanoScheme as FacilitatorScheme } from "@x402/cardano/exact/facilitator";
import { NETWORK, formatAmount, provider, shortAddress, type Amount } from "./config.ts";
import { emit } from "./events.ts";

export type Price = Amount | ((context: HTTPRequestContext) => Amount | Promise<Amount>);
type RouteKey = `${"GET" | "POST"} /${string}`;

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

const toPrice = ({ asset, amount }: Amount) => ({ asset, amount: amount.toString() });

export class Seller {
  readonly app = express();
  private readonly routes: Record<string, RouteConfig> = {};
  private middleware?: RequestHandler;

  constructor(readonly wallet: { name: string; address: string }) {
    this.app.use(express.json({ limit: "5mb" }));
    // Installed first so it guards every paid route; built in listen() once all routes are known.
    this.app.use((req, res, next) => (this.middleware ? this.middleware(req, res, next) : next()));
  }

  /** Registers a paid route. The handler runs only after the payment is verified. */
  paid(route: RouteKey, options: { price: Price; description: string }, handler: RequestHandler): this {
    const { price } = options;
    this.routes[route] = {
      accepts: {
        scheme: "exact",
        network: NETWORK,
        payTo: this.wallet.address,
        price: typeof price === "function" ? async (context) => toPrice(await price(context)) : toPrice(price),
        maxTimeoutSeconds: 600,
        extra: { assetTransferMethod: "default", areFeesSponsored: false, confirmationPolicy: { l1Confirmations: 0 } },
      },
      description: options.description,
      mimeType: "application/json",
    };
    const [method, path] = route.split(" ") as ["GET" | "POST", string];
    if (method === "GET") this.app.get(path, handler);
    else this.app.post(path, handler);
    return this;
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<{ url: string; close: () => Promise<void> }> {
    const server = new x402ResourceServer(facilitator()).register(NETWORK, new ServerScheme());
    server.onAfterVerify(async ({ requirements, result }) => {
      const amount = formatAmount(requirements.asset, requirements.amount);
      emit({
        kind: "payment.held",
        actor: this.wallet.name,
        message: `${this.wallet.name} verified a signed ${amount} payment${result.payer ? ` from ${shortAddress(result.payer)}` : ""}; it is held until the work succeeds`,
        data: { payer: result.payer },
      });
    });
    this.middleware = paymentMiddleware(this.routes, server);
    const listener = this.app.listen(port, host);
    await new Promise((resolve, reject) => listener.once("listening", resolve).once("error", reject));
    const url = `http://${host}:${(listener.address() as AddressInfo).port}`;
    return { url, close: () => new Promise((resolve) => listener.close(() => resolve())) };
  }
}
