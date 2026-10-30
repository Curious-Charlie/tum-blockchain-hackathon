/**
 * Publishes a short CIP-20 record on preprod from the BUYER wallet and prints
 * the cardanoscan link (check the "Metadata" tab).
 *
 *   npm run publish-test
 */
import { Wallet, flushEvents, publish, setApp } from "@agentic/core";

setApp("smoke");
const wallet = (await Wallet.load("BUYER", "Smoke buyer")).online();
const record = await publish(wallet, [
  "Agentic Commerce on Cardano: CIP-20 publish test",
  `Published at ${new Date().toISOString()}`,
  "AI interprets, deterministic checks gate money.",
], { title: "a test record" });
console.log(record.url);
await flushEvents();
