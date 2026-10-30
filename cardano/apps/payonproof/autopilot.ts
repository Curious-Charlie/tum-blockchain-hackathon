/**
 * The agents on their own, over several invoices and cycles (from cardano/):
 *
 *   npm run autopilot -w apps/payonproof -- --rounds 3 --every 4 --watch 3
 *
 * Every round new invoices arrive in Lena's inbox. For each one her agent asks
 * the Keepers for a price, reads their records on chain, picks one in code and
 * locks its fee in Masumi escrow. Each Keeper then loops on its own: fetch a
 * Nodary-signed EUR/USD rate, compare it with the order's limit, execute on the
 * EVM chain when it holds, put the result hash into the escrow, publish a
 * receipt. Every execution leaves an InvoicePaid event and a receipt on Cardano,
 * which the next round's choice reads: a new Keeper that delivers small invoices
 * earns the record it needs for larger ones.
 *
 * Collect the fees after the unlock time: npm run escrow -w apps/payonproof -- finish --wait
 */
import { parseArgs } from "node:util";
import { emit, flushEvents, setApp, sleep, usageSummary } from "@agentic/core";
import { fetchSignedRate } from "./evm.ts";
import { finishJob, hireForInvoice, startTeam } from "./team.ts";

const { values: args } = parseArgs({
  options: {
    rounds: { type: "string", default: "3" },
    every: { type: "string", default: "4" }, // minutes between rounds
    watch: { type: "string", default: "3" }, // minutes a Keeper watches an order
    interval: { type: "string", default: "15" }, // seconds between a Keeper's checks
    first: { type: "string", default: "101" }, // number of the first invoice
    evm: { type: "string" },
  },
});

setApp("payonproof");
const team = await startTeam({ evm: args.evm, intervalSec: Number(args.interval), receipts: true });
const rounds = Number(args.rounds);
const watch = Number(args.watch);
let invoice = Number(args.first);
const jobs: Promise<{ line: string }>[] = [];
const small = [120, 80, 150, 200];
const large = [600, 450, 900, 300];

try {
  emit({ kind: "task.started", actor: team.lenaWallet.name, message: `Autopilot: ${rounds} rounds, one every ${args.every} min. Each round brings new invoices; Keepers check the Nodary-signed EUR/USD every ${args.interval} s and execute when a limit holds` });
  for (let round = 0; round < rounds; round++) {
    if (round) await sleep(Number(args.every) * 60_000);
    const live = await fetchSignedRate();
    const rate = Number(live.display);
    const above = (Math.ceil((rate + 0.003) * 1000) / 1000).toFixed(3); // holds now
    const below = (Math.floor((rate - 0.002) * 1000) / 1000).toFixed(3); // holds only if the euro gets cheaper
    const stamp = new Date().toISOString().slice(11, 16);
    emit({ kind: "task.step", actor: team.lenaWallet.name, message: `Round ${round + 1}/${rounds}: EUR/USD ${live.display}; two new invoices in the inbox` });
    const inbox = [
      `Pay Café Verde invoice INV-${invoice++} for €${small[round % 4]} once EUR/USD is below ${above}. Due November ${20 + round}.`,
      `Pay Fazenda Alta invoice INV-${invoice++}, €${large[round % 4]}, when EUR/USD is under ${round % 2 ? below : above}; deadline November ${22 + round}.`,
    ];
    for (const text of inbox) {
      const hired = await hireForInvoice(team, text, stamp, watch).catch((error) => {
        emit({ kind: "task.failed", actor: team.lenaWallet.name, message: `Could not place "${text.slice(0, 40)}…": ${error instanceof Error ? error.message : String(error)}` });
        return undefined;
      });
      if (hired) jobs.push(finishJob(team, hired, watch));
    }
  }
  const lines = (await Promise.all(jobs)).map((j) => j.line);
  const executed = lines.filter((l) => l.includes("executed by")).length;
  emit({ kind: "task.done", actor: team.lenaWallet.name, message: `Autopilot done: ${lines.length} invoices, ${executed} executed on chain. ${lines.join(" · ")}` });
  console.log(`\n${lines.join("\n")}\n\nCollect the fees after the unlock time: npm run escrow -w apps/payonproof -- finish --wait\n${usageSummary()}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await team.close();
  await flushEvents();
}
