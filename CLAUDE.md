# CLAUDE.md

Entry for the **TUM Blockchain & AI Hackathon 2026** (Munich). **Submission deadline: Sat 2026-10-31 15:00 CET on Devfolio — aim to submit by 14:30.** Solo participant; Claude is the only teammate.

Design notes: `docs/DESIGN.md` (§4 D1). Honest limitations: `docs/LIMITATIONS.md`. Devfolio draft: `docs/SUBMISSION.md`. Timeline and checklist: `docs/PLAN.md`. Track rules: `docs/TRACKS.md`.

## Working with the user

- Reply in **Chinese**. Code, commits and identifiers stay in English.
- The user is new to web3. When a blockchain concept matters to a decision, explain it in one plain sentence.
- Be decisive. Don't reopen settled decisions (below). Give short status updates while working.
- The user handles sign-ups and logins. They report Blockfrost, Coinbase CDP, Devfolio and Sokosumi are set up. The Claude in Chrome extension is available for browser chores (faucets, dashboards).
- Never paste secrets into chat or logs.

## Settled decisions

- **The submission is D1 PayOnProof**, entered in **two tracks: Cardano** ("Agentic Commerce on Cardano") **and API3** ("Any API in your contract"). Decided Fri 17:00; "Trust, but rerun" was dropped.
- `main` holds D1 (including `api3/`). D5 ReproBounty is archived on `d5/reprobounty` and `archive/d5-main`; D2 CheckedFacts on `d2/checkedfacts`. Don't delete those branches.
- **Never merge the old D5 `main` into `d1/payonproof`**: it deletes `api3/` and the app (55 files).
- Judges stress three directions; D1 covers them: **Seller** (Keepers sell jobs over x402), **Buyer** (Lena's agent compares quotes and on-chain records, signs only the chosen offer), **Coworker** (Keeper fee in Masumi escrow, released after delivery).
- API3 bonus: autonomous multi-cycle execution (`autopilot`), and a second signed rate bought over x402 (Frankfurter on AirnodeHub, aUSD) before each execution.
- Principle: **AI interprets, deterministic checks gate money.** An LLM never decides alone whether a payment settles.
- **AgentGuard was removed on Sat 10-31** (the user found it 鸡肋): no budgets, allowlist, audit log or kill switch. `payOffer` only checks that a payment is the accepted offer. Don't bring it back.
- Rejected, don't propose again: a listing-optimizer agent team, the BSV track, a single-design plan.

## Repository layout

```
cardano/        npm workspaces (Cardano side)
  packages/core/     @agentic/core: wallets, x402 seller kit, Masumi escrow (core/escrow), market (core/market), payOffer (core/pay), CIP-20, dashboard
  apps/payonproof/   D1: lena.ts, keeper.ts, records.ts, proof.ts, crosscheck.ts, evm.ts, demo/autopilot/escrow/check/keepers/tamper/deploy
  scripts/           smoke-x402.ts, publish-test.ts
api3/           Foundry project from the AirnodeHub starter (MIT): InvoiceEscrow, DemoUSD, tests; libs as submodules
docs/           LIMITATIONS (en, zh), SUBMISSION, DESIGN, PLAN, TRACKS
reference/      upstream demos cloned for reading only (gitignored, never edit)
```

### `@agentic/core` in one screen

```ts
import { Wallet, Seller, payOffer, PaymentRefused, publish, askJson, emit, ada, usdm, HAIKU } from "@agentic/core";
import { confirmLock, submitResult, authorizeRefund, collect, withdrawRefund, escrowOutputOf } from "@agentic/core/escrow";
import { getQuote, choose, settlementTx } from "@agentic/core/market";
const me = (await Wallet.load("KEEPER", "Keeper Atlas")).online();          // <ROLE>_MNEMONIC from the app's .env
const shop = new Seller(me).paid("POST /orders/:id/watch", { price: usdm(2), description: "...", escrow: true }, handler); // escrow: buyer locks into Masumi
shop.onSettled((settled) => { /* after settlement: escrow lock → confirmLock(me, settled, price) → work → submitResult / authorizeRefund */ });
const res = await payOffer(me, quote, url, init, { task: "INV-18", purpose: "..." });  // signs only this offer (seller, ≤ amount, asset, Masumi escrow); else throws PaymentRefused
```

- `wallet.exclusive()` serializes spending per wallet and waits for the previous tx to confirm (remembered on disk across runs).
- Escrow jobs are stored per app in `cardano/.cache/escrow/<app>/`. Masumi timing: with the shortest legal deadlines the seller collects 32 min after the quote, a no-show is refundable after 17 min, a seller-authorized refund is immediate. On stage show the lock live and earlier collect transactions.

## Commands

```sh
cd cardano && npm run dashboard                         # live dashboard on http://127.0.0.1:4000 (keep it running)
cd cardano && npm run wallets -w apps/payonproof -- --fund
cd cardano && npm run keepers -w apps/payonproof        # Keeper records from chain; --fund-eth, --fund-ausd
cd cardano && npm run demo -w apps/payonproof           # escrow mode (-- --x402 | --vanish | --watch N | --no-cross-check | --evm anvil)
cd cardano && npm run autopilot -w apps/payonproof      # several invoices and rounds
cd cardano && npm run escrow -w apps/payonproof -- finish --wait
cd cardano && npm run check -w apps/payonproof -- <receipt tx>
cd cardano && npm run tamper -w apps/payonproof         # API3 tamper test (-- --file response.json)
cd cardano && npm test && npm run typecheck
cd api3 && forge test && pnpm test
```

## Secrets and wallets

- `cardano/.env`: `BUYER_MNEMONIC` (treasury), `SELLER_MNEMONIC`, `BLOCKFROST_PROJECT_ID`, `ANTHROPIC_API_KEY`. `api3/.env`: `PRIVATE_KEY` / `PAYER_PRIVATE_KEY` (Base Sepolia, Lena's EVM treasury `0xA164c012f41909C3eD9a18b86F022a3F5E7f1f1c`), `RPC_URL`.
- `cardano/apps/payonproof/.env`: `LENA_MNEMONIC`, `KEEPER{,_B,_C}_MNEMONIC`, `KEEPER{,_B,_C}_EVM_PRIVATE_KEY`.
- `.env` files are gitignored and **not present in new worktrees**: copy the ones you need.
- **Every role has its own wallet.** Two processes spending from one Cardano wallet fight over the same UTxOs.
- Fund preprod wallets at https://dispenser.masumi.network (Testnet, 100 tADA + 100 tUSDM). Base Sepolia ETH is scarce (Lena's treasury ~0.0005 ETH): createOrder ≈ 0.0000019 ETH, execute ≈ 0.0000014 ETH. aUSD: AirnodeHub faucet, 10 per account.

## Cardano / x402 / API3 facts learned the hard way

- Pinned versions: `@x402/*` 2.26.0 (incl. `@x402/evm`), `@evolution-sdk/evolution` 0.5.13, `typescript` 5.9.3.
- **Use Blockfrost**; set `awaitConfirmation: false` on the facilitator signer. Starter plan: 50,000 requests a day, no tight polling loops.
- **Settle only on success:** a paid handler answering ≥ 400 means the buyer's signed transaction is never submitted.
- tUSDM (Masumi dispenser) has policy `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde`, asset name `0014df10745553444d`; x402 needs the dotted form (core `TUSDM`), Blockfrost and evolution-sdk the undotted unit (`toUnit` / `fromUnit`).
- CIP-20 metadata: label 674, strings of at most 64 bytes. Explorer: `https://preprod.cardanoscan.io/transaction/<hash>`.
- Nodary EUR/USD request hash `0x5ccc3aa9…d3d0`; the escrow accepts a rate up to 3 days old and a response at most 5 minutes old. FX may freeze from Fri 22:00 UTC.
- AirnodeHub request hash = keccak256(JSON.stringify([operation, parameter entries sorted by name])); priced calls are x402 `exact` on Base Sepolia in aUSD (`0xbeA3…1808`), the facilitator pays gas.

## Anthropic API

- Models: `claude-sonnet-5-5` for main agents, `claude-haiku-5-5` for helpers. Budget $200: answers are cached in `cardano/.cache/claude`.
- Load the `claude-api` skill before writing Anthropic SDK code.

## Git

- Work on `d1/payonproof` in `.worktrees/d1-payonproof`; `main` gets D1 through new commits (never force-push).
- Commit small and often, push to `origin` (private GitHub repo).
- **Ask the user first** before making the repo public, force-pushing, deleting branches, submitting on Devfolio, or posting anything outside the repo.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
