/**
 * Creates the buyer and seller preprod wallets on first run, then prints their
 * addresses and balances. Mnemonics are written to .env only, never printed.
 *
 *   npm run wallets
 */
import { chmodSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Address, Client, preprod } from "@evolution-sdk/evolution";
import dotenv from "dotenv";

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const KOIOS_URL = process.env.KOIOS_URL ?? "https://preprod.koios.rest/api/v1";
const WALLETS = ["BUYER", "SELLER"] as const;

function ensureMnemonics() {
  const existing = existsSync(ENV_PATH) ? dotenv.parse(readFileSync(ENV_PATH)) : {};
  for (const role of WALLETS) {
    const key = `${role}_MNEMONIC`;
    if (existing[key]) continue;
    appendFileSync(ENV_PATH, `${key}="${generateMnemonic(wordlist, 256)}"\n`);
    console.log(`Created ${key} in .env`);
  }
  chmodSync(ENV_PATH, 0o600);
  return dotenv.parse(readFileSync(ENV_PATH));
}

async function addressOf(mnemonic: string) {
  return Address.toBech32(await Client.make(preprod).withSeed({ mnemonic }).address());
}

async function balances(addresses: string[]) {
  const response = await fetch(`${KOIOS_URL}/address_info`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ _addresses: addresses }),
  });
  if (!response.ok) throw new Error(`Koios address_info returned ${response.status}`);
  const rows = (await response.json()) as { address: string; balance: string; utxo_set: { asset_list: { asset_name: string; quantity: string }[] }[] }[];
  return new Map(rows.map((row) => {
    const tokens = new Map<string, bigint>();
    for (const utxo of row.utxo_set) {
      for (const asset of utxo.asset_list) {
        const name = Buffer.from(asset.asset_name, "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "");
        tokens.set(name, (tokens.get(name) ?? 0n) + BigInt(asset.quantity));
      }
    }
    return [row.address, { lovelace: BigInt(row.balance), tokens }];
  }));
}

const env = ensureMnemonics();
const addresses = await Promise.all(WALLETS.map((role) => addressOf(env[`${role}_MNEMONIC`]!)));
const funds = await balances(addresses);

for (const [index, role] of WALLETS.entries()) {
  const address = addresses[index]!;
  const found = funds.get(address);
  const ada = found ? Number(found.lovelace) / 1e6 : 0;
  const tokens = found ? [...found.tokens].map(([name, quantity]) => `${quantity} ${name || "(unnamed)"}`).join(", ") : "";
  console.log(`${role.padEnd(6)} ${address}`);
  console.log(`       ${ada} tADA${tokens ? `, ${tokens}` : ""}`);
}
