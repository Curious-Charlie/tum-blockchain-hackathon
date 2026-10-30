/**
 * API3 tamper test against the deployed escrow: one valid, fresh Nodary
 * response executes an order; four tampered responses are rejected by the
 * contract itself (dry runs with eth_call, so they cost no gas).
 *
 *   npm run tamper -w apps/payonproof                              # from cardano/
 *   npm run tamper -w apps/payonproof -- --file my-response.json   # also try your own response
 *
 * A response file has { timestamp, data, signature }, as `pnpm --silent
 * fetch-response EUR/USD > my-response.json` in api3/ prints it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT, emit, flushEvents, setApp } from "@agentic/core";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { EUR_USD_REQUEST_HASH, connectEvm, fetchSignedFeed, fetchSignedRate, responseDigest, showRate, toRate, usd, type SignedRate } from "./evm.ts";
import { ADDRESS_BOOK } from "./lena.ts";

const { values: args } = parseArgs({ options: { evm: { type: "string" }, file: { type: "string" }, "skip-valid": { type: "boolean", default: false } } });
setApp("payonproof");
const actor = "API3 tamper test";
const evm = await connectEvm(args.evm);
let failures = 0;

try {
  const live = await fetchSignedRate();
  const limit = Math.ceil((Number(live.display) + 0.01) * 100) / 100;
  emit({ kind: "task.started", actor, link: evm.explorer ? evm.addressLink(evm.escrow) : undefined, linkLabel: "contract on basescan ↗", message: `Tamper test on ${evm.name}, escrow ${evm.escrow}. Live Nodary EUR/USD ${live.display}; opening a €100 order that pays when EUR/USD < ${limit}` });
  const order = await evm.createOrder({
    invoiceRef: "TAMPER-TEST",
    payee: ADDRESS_BOOK.cafeverde.address,
    amountEurCents: 100_00n,
    maxRate: toRate(limit),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 86_400),
  });
  const orderRef = evm.txRef(order.hash);
  emit({ kind: "task.step", actor, message: `Order ${order.orderId} locks ${usd(order.deposit)}${orderRef.note}`, link: orderRef.link, linkLabel: orderRef.linkLabel });

  const editedPrice = (data: string) => data.replace(/"price":([\d.]+)/, (_m, p: string) => `"price":${(Number(p) - 0.1).toFixed(4)}`);
  const impostor = privateKeyToAccount(generatePrivateKey());
  const forgedData = editedPrice(live.signed.data);
  const fixture = JSON.parse(readFileSync(path.join(ROOT, "..", "api3", "test", "fixtures", "nodary-eur-usd.json"), "utf8")) as SignedRate;
  const cases: [string, Pick<SignedRate, "timestamp" | "data" | "signature">][] = [
    ["1 · real response, one value edited", { ...live.signed, data: editedPrice(live.signed.data) }],
    [`2 · real response, too old (signed ${new Date(Number(fixture.timestamp) * 1000).toISOString().slice(0, 16)}Z)`, fixture],
    ["3 · real, fresh response for another request (BTC/USD)", await fetchSignedFeed("BTC/USD")],
    [`4 · signed by another key (${impostor.address.slice(0, 10)}…)`, { timestamp: live.signed.timestamp, data: forgedData, signature: await impostor.signMessage({ message: { raw: responseDigest(EUR_USD_REQUEST_HASH, live.signed.timestamp, forgedData) } }) }],
  ];
  if (args.file) {
    const own = JSON.parse(readFileSync(args.file, "utf8")) as SignedRate;
    cases.push([`your response (${args.file})`, own]);
  }

  for (const [label, response] of cases) {
    const error = await evm.simulate(order.orderId, response);
    const own = label.startsWith("your");
    if (!error && !own) failures++;
    emit({
      kind: error ? "task.failed" : own ? "task.done" : "task.failed",
      actor,
      message: error ? `REJECTED ${label}: ${error}` : `${own ? "ACCEPTED" : "NOT REJECTED (bug!)"} ${label}`,
      data: { data: response.data },
    });
  }

  if (!args["skip-valid"]) {
    const result = await evm.execute(order.orderId, live.signed);
    const ref = evm.txRef(result.hash);
    emit({ kind: "task.done", actor, message: `ACCEPTED the valid, fresh response (EUR/USD ${showRate(result.rate)}): paid ${usd(result.payout)}, refunded ${usd(result.refund)}${ref.note}`, link: ref.link, linkLabel: ref.linkLabel, data: { evmTx: result.hash } });
  }
  console.log(failures ? `\n${failures} tampered response(s) were not rejected` : "\nTamper test passed: the valid response executed, every tampered response was rejected.");
} catch (error) {
  failures++;
  emit({ kind: "task.failed", actor, message: `Tamper test stopped: ${error instanceof Error ? error.message : String(error)}` });
} finally {
  evm.close();
  await flushEvents();
  process.exitCode = failures ? 1 : 0;
}
