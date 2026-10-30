/**
 * Creates missing wallets, prints addresses and balances, and optionally tops
 * them up from the treasury wallet (BUYER in cardano/.env).
 *
 *   npm run wallets                      # cardano/: BUYER (treasury) and SELLER
 *   npm run wallets -w apps/<design>     # the roles in apps/<design>/roles.ts
 *   npm run wallets -w apps/<design> -- --fund
 *
 * Mnemonics are written to .env only, never printed.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EXPLORER_TX, LOVELACE, ROOT, TUSDM, ada, formatAmount, type Amount } from "../config.ts";
import { Wallet, ensureMnemonics, type RoleSpec } from "../wallets.ts";

const cwd = process.cwd();
const rolesFile = path.join(cwd, "roles.ts");
const isApp = existsSync(rolesFile) && cwd !== ROOT;
const roles: RoleSpec[] = isApp
  ? ((await import(pathToFileURL(rolesFile).href)) as { roles: RoleSpec[] }).roles
  : [{ role: "BUYER", name: "Treasury (smoke buyer)" }, { role: "SELLER", name: "Smoke seller" }];
const envPath = isApp ? path.join(cwd, ".env") : path.join(ROOT, ".env");

for (const role of ensureMnemonics(envPath, roles.map((r) => r.role))) console.log(`Created ${role.toUpperCase()}_MNEMONIC in ${envPath}`);

const wallets = await Promise.all(roles.map((r) => Wallet.load(r.role, r.name)));
const balances = await Promise.all(wallets.map((w) => w.balance()));
for (const [i, wallet] of wallets.entries()) {
  const b = balances[i]!;
  console.log(`${wallet.role.padEnd(12)} ${wallet.name}`);
  console.log(`${"".padEnd(12)} ${wallet.address}`);
  console.log(`${"".padEnd(12)} ${formatAmount(LOVELACE, b[LOVELACE] ?? 0n)}, ${formatAmount(TUSDM, b[TUSDM] ?? 0n)}`);
}

if (process.argv.includes("--fund")) {
  const treasury = await Wallet.load(process.env.TREASURY_ROLE ?? "BUYER", "Treasury");
  const outputs: { address: string; amounts: Amount[] }[] = [];
  for (const [i, spec] of roles.entries()) {
    if (!spec.fund || wallets[i]!.address === treasury.address) continue;
    const shortfall = spec.fund
      .map(({ asset, amount }) => ({ asset, amount: amount - (balances[i]![asset] ?? 0n) }))
      .filter((a) => a.amount > 0n);
    if (!shortfall.length) continue;
    // Every output carries at least 2 tADA so token-only top-ups still meet the min-UTxO.
    const lovelace = shortfall.find((a) => a.asset === LOVELACE)?.amount ?? 0n;
    const amounts = [...shortfall.filter((a) => a.asset !== LOVELACE), ada(Math.max(2, Number(lovelace) / 1e6))];
    outputs.push({ address: wallets[i]!.address, amounts });
    console.log(`Fund ${spec.role}: ${amounts.map((a) => formatAmount(a.asset, a.amount)).join(", ")}`);
  }
  if (!outputs.length) console.log("Every role is funded.");
  else {
    const tx = await treasury.send(outputs);
    console.log(`Funding transaction: ${EXPLORER_TX}${tx}`);
  }
}
