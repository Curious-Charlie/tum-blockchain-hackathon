/**
 * Role wallets. Every design and every role has its own wallet (mnemonic in
 * `<ROLE>_MNEMONIC`), because two processes spending from one wallet fight over
 * the same UTxOs.
 *
 * Spending from one wallet is serialized with `exclusive()`: it waits until the
 * wallet's previous transaction is in a block, so the next transaction never
 * picks a UTxO that is already spent in the mempool. The last transaction is
 * also kept on disk, so a second run right after the first waits too.
 */

const PENDING_DIR = path.join(ROOT, ".cache", "pending");
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import dotenv from "dotenv";
import { Address, Assets, Client, TransactionHash, preprod } from "@evolution-sdk/evolution";
import { toClientCardanoSigner, type ClientCardanoSigner } from "@x402/cardano";
import { BLOCKFROST_URL, LOVELACE, NETWORK, ROOT, blockfrost, fromUnit, provider, required, sleep, toUnit, waitForTx, type Amount } from "./config.ts";
import { emit } from "./events.ts";

/** One wallet role of an app, listed in the app's roles.ts. */
export interface RoleSpec {
  /** Env prefix: the mnemonic lives in `<ROLE>_MNEMONIC`. */
  role: string;
  /** Display name on the dashboard. */
  name: string;
  /** Top-up target for `npm run wallets -- --fund` (roles that pay need funds). */
  fund?: Amount[];
}

export interface Balance {
  /** Canonical asset id (`TUSDM`, "lovelace") → quantity in smallest units. */
  [asset: string]: bigint;
}

export class Wallet {
  private signingClient?: ReturnType<typeof makeSigningClient>;
  private x402?: ClientCardanoSigner;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    /** Env name, e.g. "REPLICATOR". */
    readonly role: string,
    /** Display name for logs and the dashboard, e.g. "Replicator agent". */
    readonly name: string,
    readonly address: string,
    private readonly mnemonic: string,
  ) {}

  static async load(role: string, name = role): Promise<Wallet> {
    const mnemonic = required(`${role.toUpperCase()}_MNEMONIC`);
    const address = Address.toBech32(await Client.make(preprod).withSeed({ mnemonic }).address());
    return new Wallet(role.toUpperCase(), name, address, mnemonic);
  }

  /** Announces the agent on the dashboard (name ↔ address). */
  online(detail?: string): this {
    emit({ kind: "agent.online", actor: this.name, message: `${this.name} online${detail ? ` — ${detail}` : ""}`, data: { address: this.address, role: this.role } });
    return this;
  }

  /** evolution-sdk client that can build, sign and submit transactions. */
  client() {
    return (this.signingClient ??= makeSigningClient(this.mnemonic));
  }

  /** x402 buyer signer (builds and signs payment transactions). */
  signer(): ClientCardanoSigner {
    return (this.x402 ??= toClientCardanoSigner({ mnemonic: this.mnemonic, network: NETWORK, provider: provider() }));
  }

  /**
   * Runs `work` alone on this wallet, after the previous transaction is confirmed.
   * Call `submitted(tx)` inside `work` for every transaction it puts on chain.
   */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const tx = this.unconfirmed();
      if (tx) {
        console.log(`  … ${this.name}: waiting for ${tx.slice(0, 10)}… to confirm before spending again`);
        await waitForTx(tx).catch((error) => console.warn(`  ! ${String(error)}`));
        // Blockfrost's UTxO index can trail /txs by a few seconds.
        await sleep(5_000);
        rmSync(this.pendingFile(), { force: true });
      }
      return work();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  submitted(txHash: string) {
    mkdirSync(PENDING_DIR, { recursive: true });
    writeFileSync(this.pendingFile(), txHash);
  }

  private pendingFile() {
    return path.join(PENDING_DIR, `${this.address}.txt`);
  }

  private unconfirmed(): string | undefined {
    return existsSync(this.pendingFile()) ? readFileSync(this.pendingFile(), "utf8").trim() || undefined : undefined;
  }

  async balance(): Promise<Balance> {
    return balanceOf(this.address);
  }

  /**
   * Builds, signs and submits a transaction alone on this wallet. Retries once
   * after 15 s: Blockfrost's UTxO index can lag a few seconds behind a block.
   */
  async transact(build: (tx: ReturnType<ReturnType<Wallet["client"]>["newTx"]>) => typeof tx): Promise<string> {
    return this.exclusive(async () => {
      const attempt = async () => {
        const signed = await (await build(this.client().newTx()).build()).sign();
        return TransactionHash.toHex(await signed.submit());
      };
      const tx = await attempt().catch(async (error) => {
        console.warn(`  ! ${this.name}: transaction failed (${error instanceof Error ? error.message : String(error)}), retrying in 15 s`);
        await sleep(15_000);
        return attempt();
      });
      this.submitted(tx);
      return tx;
    });
  }

  /** Sends assets to several addresses in one transaction. Returns the tx hash. */
  async send(outputs: { address: string; amounts: Amount[] }[]): Promise<string> {
    return this.transact((tx) => {
      for (const output of outputs) tx = tx.payToAddress({ address: Address.fromBech32(output.address), assets: toAssets(output.amounts) });
      return tx;
    });
  }
}

function makeSigningClient(mnemonic: string) {
  return Client.make(preprod)
    .withBlockfrost({ baseUrl: BLOCKFROST_URL, projectId: required("BLOCKFROST_PROJECT_ID") })
    .withSeed({ mnemonic });
}

export function toAssets(amounts: Amount[]) {
  let assets = Assets.fromLovelace(amounts.filter((a) => a.asset === LOVELACE).reduce((sum, a) => sum + a.amount, 0n));
  for (const { asset, amount } of amounts) {
    if (asset === LOVELACE) continue;
    const unit = toUnit(asset);
    assets = Assets.addByHex(assets, unit.slice(0, 56), unit.slice(56), amount);
  }
  return assets;
}

export async function balanceOf(address: string): Promise<Balance> {
  const info = await blockfrost<{ amount: { unit: string; quantity: string }[] }>(`/addresses/${address}`);
  const balance: Balance = { lovelace: 0n };
  for (const { unit, quantity } of info?.amount ?? []) balance[fromUnit(unit)] = BigInt(quantity);
  return balance;
}

/** Appends `<ROLE>_MNEMONIC` to `envPath` for every role that has none. Returns the roles created. */
export function ensureMnemonics(envPath: string, roles: string[]): string[] {
  const existing = existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {};
  const created: string[] = [];
  for (const role of roles) {
    const key = `${role.toUpperCase()}_MNEMONIC`;
    if (existing[key] || process.env[key]) continue;
    const mnemonic = generateMnemonic(wordlist, 256);
    appendFileSync(envPath, `${key}="${mnemonic}"\n`);
    process.env[key] = mnemonic;
    created.push(role);
  }
  if (existsSync(envPath)) chmodSync(envPath, 0o600);
  return created;
}
