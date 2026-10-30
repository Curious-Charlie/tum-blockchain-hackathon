# CLAUDE.md

Entry for the **TUM Blockchain & AI Hackathon 2026** (Munich). **Submission deadline: Sat 2026-10-31 15:00 CET on Devfolio — aim to submit by 14:30.** Solo participant; Claude is the only teammate.

Full design: `docs/DESIGN.md` (§4 D5 is the submission). Honest limitations: `docs/LIMITATIONS.md`. Timeline and submission checklist: `docs/PLAN.md`. Official track rules: `docs/TRACKS.md`.

## Working with the user

- Reply in **Chinese**. Code, commits and identifiers stay in English.
- The user is new to web3. When a blockchain concept matters to a decision, explain it in one plain sentence.
- Be decisive. Don't reopen settled decisions (below). Give short status updates while working.
- The user handles sign-ups and logins. They report Blockfrost, Coinbase CDP, Devfolio and Sokosumi are set up. The Claude in Chrome extension is available for browser chores (faucets, dashboards).
- Never paste secrets into chat or logs.

## Settled decisions

- **Primary track: Cardano** ("Agentic Commerce on Cardano", €6k). BSV and API3 are dropped.
- **The submission is D5 ReproBounty** (chosen Fri 12:40; the 18:30 internal demo is cancelled). It is on `main`. D1 PayOnProof (`d1/payonproof`) and D2 CheckedFacts (`d2/checkedfacts`) stay on their branches and never go into `main`.
- Judges stress three directions, and D5 covers all three: **Seller** (x402 paid endpoints), **Buyer** (an agent finds services, decides what they are worth and pays without overspending: AgentGuard), **Coworker** (Masumi: agents work together, settlement after delivery, escrow).
- Work order (done Fri 13:30): (1) safety net on `main`: three demo paths, cold-start README, clean history, limitations doc; (2) Masumi escrow for the Requester → Replicator bounty only (`--escrow`), x402 stays the default; (3) Buyer: three compute agents with different prices and track records, the Replicator chooses in code within its AgentGuard budget and explains why on the dashboard.
- Masumi escrow facts: collect is possible only from the unlock time (32 min after the quote with the shortest legal deadlines), a no-show refund from the submit-result deadline (17 min); a seller-authorized refund is immediate. On stage show the lock live and earlier collect/refund transactions.
- **D4 AgentGuard** (spend policies for paying agents) is the shared buyer-side infrastructure.
- Rejected, don't propose again: a listing-optimizer agent team, the BSV track, a single-design plan.
- Principle: **AI interprets, deterministic checks gate money.** An LLM never decides alone whether a payment settles.

## Repository layout

```
cardano/        npm workspaces (Cardano track, main work)
  packages/core/  @agentic/core: shared infrastructure (Phase 0, done)
  apps/reprobounty/  D5 ReproBounty, the submission (roles.ts, .env.example, README with demo script)
  scripts/        smoke-x402.ts (end-to-end paid request), publish-test.ts (CIP-20 record)
docs/           DESIGN.md, PLAN.md, TRACKS.md
reference/      upstream demos cloned for reading only (gitignored, never edit)
```

### `@agentic/core` in one screen

```ts
import { Wallet, AgentGuard, Seller, publish, runAgent, askJson, emit, ada, usdm, limits, payees, SONNET, HAIKU } from "@agentic/core";
const me = (await Wallet.load("REPLICATOR", "Replicator agent")).online();   // <ROLE>_MNEMONIC from the app's .env
const shop = new Seller(me).paid("POST /replicate", { price: usdm(5), description: "..." }, handler); // handler status >= 400 => buyer pays nothing
await shop.listen(4150);
shop.onSettled(({ tx, body }) => { /* runs after settlement, e.g. publish a receipt */ });
const guard = new AgentGuard(me, { maxPerPayment: limits(ada(3)), maxPerTask: limits(ada(5)), maxPerDay: limits(ada(30)), payees: payees(compute) });
const res = await guard.fetch(url, init, { task: "job-1", purpose: "compute run" }); // throws PaymentBlocked when the policy refuses
await publish(me, ["line <= 64 bytes", "..."], { title: "a certificate" });   // CIP-20 label 674
emit({ kind: "task.step", actor: me.name, message: "..." });                  // dashboard timeline
emit({ kind: "payment.external", from: "Escrow", to: "Supplier", amount: "448 dUSD", message: "...", link: basescanUrl, linkLabel: "basescan ↗" });
```

- `wallet.exclusive()` serializes spending per wallet and waits for the previous tx to confirm (remembered on disk across runs); `guard.fetch`, `publish` and `wallet.send` already use it. `guard.fetch` retries once when a seller rejects the signed payment with 402 (lagging chain view).
- `runAgent` (tool-use loop) and `askJson` (structured output) cache every Claude response on disk (`cardano/.cache/claude`, `CLAUDE_CACHE=0` to bypass); `usageSummary()` prints cost.
- Audit logs: `cardano/.audit/<app>-<role>.jsonl`. Kill switch: `npm run freeze` / dashboard button.

## Commands

```sh
cd cardano && npm run dashboard                       # live dashboard on http://127.0.0.1:4000 (keep it running)
cd cardano && npm run wallets                         # treasury (BUYER) and SELLER: create if missing, print balances
cd cardano && npm run wallets -w apps/<app> -- --fund # app role wallets; --fund tops up from the treasury
cd cardano && npm run smoke                           # real 1 tADA x402 payment through AgentGuard; HTTP 200 + tx hash
cd cardano && npm run publish-test                    # CIP-20 record on preprod
cd cardano && npm test                                # AgentGuard policy tests
cd cardano && npm run typecheck
cd cardano && npm run demo -w apps/reprobounty        # ReproBounty end to end (-- --altered | --tamper | --escrow [--tamper|--vanish])
cd cardano && npm run escrow -w apps/reprobounty      # escrow jobs; -- finish --wait collects / refunds when due
```

## Secrets and wallets

- `cardano/.env`: `BUYER_MNEMONIC` (also the treasury), `SELLER_MNEMONIC`, `BLOCKFROST_PROJECT_ID`, `ANTHROPIC_API_KEY`. D1's Base Sepolia keys live in `api3/.env` on the `d1/payonproof` worktree only.
- Each app keeps its role mnemonics in `cardano/apps/<app>/.env`; shared keys stay in `cardano/.env`.
- `.env` files are gitignored and **not present in new worktrees**: copy the ones you need.
- **Give every design and every role its own wallet.** Two processes spending from one Cardano wallet fight over the same UTxOs and their payments fail.
- Fund preprod wallets at https://dispenser.masumi.network (Testnet, paste the address, Claim Tokens; no captcha; gives 100 tADA + 100 tUSDM). Use Chrome.

## Cardano / x402 facts learned the hard way

- Pinned versions: `@x402/*` 2.26.0, `@evolution-sdk/evolution` 0.5.13, `typescript` 5.9.3. Keep them in step.
- Pattern to copy: `cardano/scripts/smoke-x402.ts`, which has an in-process facilitator (no separate service), an express `paymentMiddleware` seller and a `wrapFetchWithPayment` buyer.
- **Use Blockfrost.** Koios can pay, but the SDK cannot confirm settlement with it, so the seller answers 402 even though the money moved. With Blockfrost set `awaitConfirmation: false` on the facilitator signer.
- Blockfrost starter plan: 50,000 requests a day. No tight polling loops.
- The buyer must allow tADA explicitly: `spendControls: { allowedAssets: [{ network: "cardano:preprod", asset: "lovelace", maxAmountPerPayment: "..." }] }`, otherwise the client refuses to pay.
- **Settle only on success:** if the paid handler responds with status >= 400, `@x402/express` cancels settlement and the buyer's signed transaction is never submitted (checked in the SDK source). Every design relies on this.
- tUSDM from the Masumi dispenser has policy `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde` (asset name `0014df10745553444d`). The SDK's default preprod USDM is a *different* token. x402 requires the canonical dotted form `policyId.assetNameHex` (core `TUSDM`); Blockfrost and evolution-sdk use the undotted unit (`toUnit` / `fromUnit` convert).
- To publish a record on Cardano, use transaction metadata (CIP-20, label 674, strings of at most 64 bytes).
- Explorer link: `https://preprod.cardanoscan.io/transaction/<hash>`.
- Right after a tx confirms, Blockfrost's UTxO index can lag a few seconds; `wallet.transact` retries once after 15 s.
- A Masumi escrow flow (lock, deliver, collect or refund) exists in `reference/x402-cardano-demo/masumi/` and is the upgrade path for the winning design.

## Anthropic API

- Models: `claude-sonnet-5-5` for main agents, `claude-haiku-5-5` for cheap helper agents. The budget is $200, so cache results and avoid loops.
- Load the `claude-api` skill before writing Anthropic SDK code.

## Git

- `main` is the integration branch. Each design gets its own branch and worktree: use the Agent tool with `isolation: "worktree"`, or create worktrees under `.worktrees/<name>` (gitignored).
- In a new worktree: copy the needed `.env` files and run `npm install` in `cardano/`.
- Only the main session edits `cardano/packages/core`.
- Commit small and often, and push to `origin` (a private GitHub repo).
- **Ask the user first** before making the repo public (only at submission), force-pushing, deleting branches, or posting anything outside the repo.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
