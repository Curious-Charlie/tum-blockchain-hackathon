/**
 * End-to-end x402 check on Cardano preprod: the buyer wallet pays 1 tADA to the
 * seller for one HTTP request, through an in-process facilitator backed by
 * Koios. Prints the payment transaction hash.
 *
 *   npm run smoke
 */
import "dotenv/config";
import express from "express";
import type { AddressInfo } from "node:net";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { toClientCardanoSigner, toFacilitatorCardanoSigner, type CardanoProviderConfig } from "@x402/cardano";
import { ExactCardanoScheme as ClientScheme } from "@x402/cardano/exact/client";
import { ExactCardanoScheme as ServerScheme } from "@x402/cardano/exact/server";
import { ExactCardanoScheme as FacilitatorScheme } from "@x402/cardano/exact/facilitator";
import { Address, Client, preprod } from "@evolution-sdk/evolution";

const NETWORK = "cardano:preprod";
const provider: CardanoProviderConfig = process.env.BLOCKFROST_PROJECT_ID
  ? { blockfrost: { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", projectId: process.env.BLOCKFROST_PROJECT_ID } }
  : { koios: { baseUrl: process.env.KOIOS_URL ?? "https://preprod.koios.rest/api/v1" } };

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env (run npm run wallets first).`);
  return value;
}

const sellerAddress = Address.toBech32(await Client.make(preprod).withSeed({ mnemonic: required("SELLER_MNEMONIC") }).address());

const facilitator = new x402Facilitator().register(NETWORK,
  // Only Blockfrost exposes the transaction evidence that lets the scheme wait for confirmation itself.
  new FacilitatorScheme(toFacilitatorCardanoSigner({ network: NETWORK, provider, awaitConfirmation: !("blockfrost" in provider && provider.blockfrost) }), { confirmationTimeoutMs: 180_000 }),
);
const facilitatorClient: FacilitatorClient = {
  verify: (payload, requirements) => facilitator.verify(payload, requirements),
  settle: async (payload, requirements) => {
    const result = await facilitator.settle(payload, requirements);
    if (!result.success) console.error("Settlement failed:", JSON.stringify(result));
    return result;
  },
  getSupported: async () => facilitator.getSupported() as Awaited<ReturnType<FacilitatorClient["getSupported"]>>,
};

const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, new ServerScheme());
const app = express();
app.use(paymentMiddleware({
  "GET /paid": {
    accepts: {
      scheme: "exact", network: NETWORK, payTo: sellerAddress,
      price: { amount: "1000000", asset: "lovelace" }, maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: "default", areFeesSponsored: false, confirmationPolicy: { l1Confirmations: 0 } },
    },
    description: "Smoke test: 1 tADA for one request", mimeType: "application/json",
  },
}, resourceServer));
app.get("/paid", (_req, res) => { res.json({ message: "Paid content delivered" }); });

const listener = app.listen(0, "127.0.0.1");
await new Promise((resolve) => listener.once("listening", resolve));
const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/paid`;

try {
  const unpaid = await fetch(url);
  console.log(`Unpaid request: HTTP ${unpaid.status}`);

  const buyer = toClientCardanoSigner({ mnemonic: required("BUYER_MNEMONIC"), network: NETWORK, provider });
  const payingFetch = wrapFetchWithPayment(fetch, x402Client.fromConfig({
    schemes: [{ network: NETWORK, client: new ClientScheme(buyer) }],
    // tADA is not a default x402 asset, so allow it explicitly with a per-payment cap.
    spendControls: { allowedAssets: [{ network: NETWORK, asset: "lovelace", maxAmountPerPayment: "5000000" }] },
  }));
  console.log(`Buyer ${buyer.getAddress()} pays 1 tADA to ${sellerAddress}...`);
  const paid = await payingFetch(url);
  console.log(`Paid request: HTTP ${paid.status}`, await paid.json());
  const receipt = paid.headers.get("PAYMENT-RESPONSE");
  if (receipt) {
    const settlement = decodePaymentResponseHeader(receipt);
    console.log(`Payment transaction: ${settlement.transaction}`);
    console.log(`Explorer: https://preprod.cardanoscan.io/transaction/${settlement.transaction}`);
  }
} finally {
  listener.close();
}
