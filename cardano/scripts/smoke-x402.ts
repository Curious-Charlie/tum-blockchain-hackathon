/**
 * End-to-end x402 check on Cardano preprod, built on @agentic/core: the buyer
 * pays 1 tADA to the seller for one HTTP request, through AgentGuard and the
 * in-process facilitator. Prints the payment transaction hash. Events show up
 * live on the dashboard (npm run dashboard).
 *
 *   npm run smoke
 */
import { AgentGuard, Seller, Wallet, ada, emit, flushEvents, limits, setApp } from "@agentic/core";

setApp("smoke");
const seller = (await Wallet.load("SELLER", "Smoke seller")).online("sells one JSON response for 1 tADA");
const buyer = (await Wallet.load("BUYER", "Smoke buyer")).online("pays through AgentGuard");

const shop = new Seller(seller).paid("GET /paid", { price: ada(1), description: "Smoke test: 1 tADA for one request" }, (_req, res) => {
  res.json({ message: "Paid content delivered" });
});
const { url, close } = await shop.listen(0);

const guard = new AgentGuard(buyer, {
  maxPerPayment: limits(ada(5)),
  maxPerTask: limits(ada(5)),
  maxPerDay: limits(ada(50)),
  payees: { [seller.address]: seller.name },
});

try {
  const unpaid = await fetch(`${url}/paid`);
  console.log(`Unpaid request: HTTP ${unpaid.status}`);
  emit({ kind: "task.started", actor: buyer.name, task: "smoke", message: `Requesting ${url}/paid (seller asks for 1 tADA)` });
  const paid = await guard.fetch(`${url}/paid`, {}, { task: "smoke", purpose: "smoke test" });
  console.log(`Paid request: HTTP ${paid.status}`, await paid.json());
  emit({ kind: paid.ok ? "task.done" : "task.failed", actor: buyer.name, task: "smoke", message: `Smoke test finished with HTTP ${paid.status}` });
} finally {
  await close();
  await flushEvents();
}
