# CLAUDE.md

Entry for the **TUM Blockchain & AI Hackathon 2026** (Munich). **Submission deadline: Sat 2026-10-31 15:00 CET on Devfolio — aim to submit by 14:30.** Solo participant; Claude is the only teammate.

Full design: `docs/DESIGN.md` (read the section for the design you work on). Timeline and submission checklist: `docs/PLAN.md`. Official track rules: `docs/TRACKS.md`.

## Working with the user

- Reply in **Chinese**. Code, commits and identifiers stay in English.
- The user is new to web3. When a blockchain concept matters to a decision, explain it in one plain sentence.
- Be decisive. Don't reopen settled decisions (below). Give short status updates while working.
- The user handles sign-ups and logins. They report Blockfrost, Coinbase CDP, Devfolio and Sokosumi are set up. The Claude in Chrome extension is available for browser chores (faucets, dashboards).
- Never paste secrets into chat or logs.

## Settled decisions

- **Primary track: Cardano** ("Agentic Commerce on Cardano", €6k). BSV is dropped. API3 is entered only if D1 wins.
- Three designs are built in parallel on shared infrastructure; the user picks one at the **Fri 18:30 internal demo**:
  - **D1 PayOnProof**: keeper agent executes conditional cross-border invoice payments, paid only on success.
  - **D2 CheckedFacts**: research agent hires a fact-checker agent; paid only if the report passes the check.
  - **D5 ReproBounty**: agent reproduces a paper's results, buys compute from another agent, gets verified, publishes a certificate on Cardano.
- **D4 AgentGuard** (spend policies for paying agents) is the shared buyer-side infrastructure, not a separate entry.
- Rejected, don't propose again: a listing-optimizer agent team (the user has built one and knows it is hard), the BSV track, a single-design plan.
- Principle: **AI interprets, deterministic checks gate money.** An LLM never decides alone whether a payment settles.

## Repository layout

```
cardano/        Cardano package: wallets, x402 kit, designs (main work)
  scripts/      wallets.ts (create/inspect wallets), smoke-x402.ts (end-to-end paid request)
api3/           Foundry project from the API3 AirnodeHub starter (MIT), libs as submodules (only D1)
docs/           DESIGN.md, PLAN.md, TRACKS.md
reference/      upstream demos cloned for reading only (gitignored, never edit)
```

Target layout after Phase 0 (see DESIGN.md §3): npm workspaces in `cardano/`, with `packages/core` (shared infrastructure) and `apps/<design>` (one per design).

## Commands

```sh
cd cardano && npm run wallets     # create missing wallets in .env, print addresses and balances
cd cardano && npm run smoke       # real 1 tADA x402 payment on preprod; expect HTTP 200 + tx hash
cd cardano && npm run typecheck
cd api3 && forge test && pnpm test
```

## Secrets and wallets

- `cardano/.env`: `BUYER_MNEMONIC`, `SELLER_MNEMONIC`, `BLOCKFROST_PROJECT_ID`, `ANTHROPIC_API_KEY`. `api3/.env`: `PRIVATE_KEY` / `PAYER_PRIVATE_KEY` (Base Sepolia, address `0xA164c012f41909C3eD9a18b86F022a3F5E7f1f1c`), `RPC_URL`.
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
- tUSDM from the Masumi dispenser has policy `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde` (unit `...0014df10745553444d`). The SDK's default preprod USDM is a *different* token, so pass Masumi's unit explicitly when charging in tUSDM.
- To publish a record on Cardano, use transaction metadata (CIP-20, label 674, strings of at most 64 bytes).
- Explorer link: `https://preprod.cardanoscan.io/transaction/<hash>`.
- A Masumi escrow flow (lock, deliver, collect or refund) exists in `reference/x402-cardano-demo/masumi/` and is the upgrade path for the winning design.

## Anthropic API

- Models: `claude-sonnet-5-5` for main agents, `claude-haiku-5-5` for cheap helper agents. The budget is $200, so cache results and avoid loops.
- Load the `claude-api` skill before writing Anthropic SDK code.

## Git

- `main` is the integration branch. Each design gets its own branch and worktree: use the Agent tool with `isolation: "worktree"`, or create worktrees under `.worktrees/<name>` (gitignored).
- In a new worktree: copy the needed `.env` files, run `npm install` in `cardano/`, and for `api3/` run `git submodule update --init --recursive`.
- During Phase 0 only the orchestrator edits `cardano/packages/core`. Design branches keep to `cardano/apps/<design>/` and ask for core changes.
- Commit small and often, and push to `origin` (a private GitHub repo).
- **Ask the user first** before making the repo public (only at submission), force-pushing, deleting branches, or posting anything outside the repo.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
