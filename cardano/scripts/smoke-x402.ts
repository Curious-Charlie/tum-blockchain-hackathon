/**
 * End-to-end x402 check on Cardano preprod, built on @agentic/core: the buyer
 * pays 1 tADA (or 0.5 tUSDM with --usdm) to the seller for one HTTP request,
 * through the in-process facilitator. Prints the payment transaction hash.
 * Events show up live on the dashboard (npm run dashboard).
 *
 *   npm run smoke
 *   npm run smoke -- --usdm
 */
import { Seller, Wallet, ada, emit, flushEvents, formatAmount, payOffer, setApp, usdm } from "@agentic/core";

setApp("smoke");
const price = process.argv.includes("--usdm") ? usdm(0.5) : ada(1);
const label = formatAmount(price.asset, price.amount);
const seller = (await Wallet.load("SELLER", "Smoke seller")).online(`sells one JSON response for ${label}`);
const buyer = (await Wallet.load("BUYER", "Smoke buyer")).online(`pays ${label} for one request`);

const shop = new Seller(seller).paid("GET /paid", { price, description: `Smoke test: ${label} for one request` }, (_req, res) => {
  res.json({ message: "Paid content delivered" });
});
const settled = new Promise<string>((resolve) => {
  shop.onSettled(({ tx, path }) => resolve(`${path} settled in ${tx}`));
});
const { url, close } = await shop.listen(0);

try {
  const unpaid = await fetch(`${url}/paid`);
  console.log(`Unpaid request: HTTP ${unpaid.status}`);
  emit({ kind: "task.started", actor: buyer.name, task: "smoke", message: `Requesting ${url}/paid (seller asks for ${label})` });
  const paid = await payOffer(buyer, { name: seller.name, address: seller.address, ...price }, `${url}/paid`, {}, { task: "smoke", purpose: "smoke test" });
  console.log(`Paid request: HTTP ${paid.status}`, await paid.json());
  emit({ kind: paid.ok ? "task.done" : "task.failed", actor: buyer.name, task: "smoke", message: `Smoke test finished with HTTP ${paid.status}` });
  if (paid.ok) console.log(`Seller onSettled: ${await settled}`);
} finally {
  await close();
  await flushEvents();
}
