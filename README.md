# PayOnProof: agents that pay invoices on signed FX rates, and get paid only on proof

> Submission for the [TUM Blockchain & AI Hackathon 2026](https://hackathon.tum-blockchain.com/) (Munich, 30–31 October 2026).
> **Tracks:** Cardano (Agentic Commerce on Cardano) · API3 (Any API in your contract)

**Demo video (1:45):** https://youtu.be/v7hk3LD6cW8

Lena runs a small coffee roastery in Munich. Her suppliers in Colombia and Brazil invoice her in euros; she holds US dollar stablecoins and wants to pay **when EUR/USD drops below her limit**, without watching the market. She tells her finance agent in one sentence. The agent locks the invoice money in an escrow contract and hires a **Keeper agent** that watches the rate and executes the payment.

- **The rate is signed data, checked by the contract.** The Keeper submits an EUR/USD rate **signed by the Nodary Airnode (API3 AirnodeHub)**. `InvoiceEscrow` on Base Sepolia checks the signer, that it answers exactly the EUR/USD request, that it is fresh, and that it is below Lena's limit, then pays the supplier `€ amount × signed rate` and refunds the rest. The Keeper can trigger the payment, never redirect it.
- **The Keeper is paid on proof.** Lena's agent locks the Keeper's fee in **Masumi escrow on Cardano** before the work. After executing, the Keeper puts a result hash into the escrow that binds the fee to the `execute` transaction and its `InvoicePaid` event, and collects after Lena's dispute window. No execution → refund.
- **The buyer agent chooses whom to pay.** Three Keepers offer the job at different prices. Lena's agent reads each Keeper's record from the chains (receipts on Cardano, verified against Base Sepolia) and picks the cheapest acceptable one within her fee limit, explaining why on a live dashboard. It then signs only that offer: the chosen Keeper, its quoted price, Masumi's escrow.
- **AI interprets, deterministic checks gate money.** Claude turns Lena's sentence into an order; code checks every field and takes the supplier's address from her address book. Contracts and code decide every payment.

```
Lena's finance agent ── order + deposit ─────────────────────────────▶ InvoiceEscrow            [Base Sepolia]
   │ asks 3 Keepers for a price, checks their records on chain
   │ chooses one in code; signs only that Keeper's quoted fee
   └── Keeper fee, x402 → Masumi escrow lock ─────────────────────────▶ Masumi escrow             [Cardano preprod]
                                Keeper: Nodary-signed EUR/USD each cycle
                                rate < limit ─▶ InvoiceEscrow.execute(order, signed response) ─▶ supplier paid
                                result hash ─▶ escrow; receipt (CIP-20) ─▶ collects after the unlock time
                                never met ─▶ authorizes a refund ─▶ Lena withdraws her fee
```

## For Cardano judges

PayOnProof is the workshop's *Beyond the payment · Business operations* case: **agents that pay invoices and settle with suppliers**. The Keepers are Coworkers that get paid: each sells one job, "watch this order and pay it when the rate is right", and is paid only after it did.

| | |
|---|---|
| **Customer and task** | Small importers paying suppliers abroad, and their finance agents: "pay when the rate is right" as a paid agent job. A Keeper earns a fee per executed invoice and nothing for watching. |
| **Seller** (x402) | Three Keepers sell the job over x402 on Cardano preprod at different prices (Atlas 2 tUSDM, Swift 1 tUSDM, Prime 4 tUSDM), paid into Masumi escrow; or per attempt in tADA, charged only on success (`--x402`). |
| **Buyer** | Lena's agent asks each Keeper for its quote, reads its record from both chains, chooses in code (fee limit 3 tUSDM, no false receipts, verified executions minus no-shows for the trial rule and ties, new Keepers start with invoices up to €250, cheapest wins) and signs only that offer: the chosen Keeper, its quoted price, Masumi's escrow contract. |
| **Coworker** (Masumi) | The fee is locked before the work and released after delivery (SubmitResult → Withdraw), or refunded (AuthorizeRefund → WithdrawRefund, or after the deadline). |
| **Sokosumi** | Lena's finance agent is a Sokosumi Coworker ("PayOnProof finance agent") in the TUM-Hackathon Workspace. A team posts one sentence as a Task; the worker (`npm run coworker -w apps/payonproof`) runs the flow above, completes the Task with every transaction link and answers follow-up comments ([sokosumi/](sokosumi/)). |
| **Cardano tools** | x402 on preprod (`@x402/cardano`, `@x402/express`, `@x402/fetch`) with an in-process facilitator; Masumi escrow (`vested_pay` V2) via x402 `assetTransferMethod: "masumi"` plus SubmitResult, Withdraw, AuthorizeRefund and WithdrawRefund built with evolution-sdk; tUSDM and tADA; CIP-20 metadata (label 674) for the Keepers' receipts; Blockfrost. |

**x402 + Masumi, item by item** (the workshop's table): address payments ✓ (per-attempt mode); refunds ✓ (authorized at once, or after the deadline when the Keeper vanishes); decision logging ✓ (the Keeper's result hash commits to the payment on Base Sepolia, `npm run check` recomputes it); public registry and identity ✗, not yet: the Keepers are not in Masumi's registry, and Lena's agent knows their URLs. Their reputation comes from the chain: receipts checked against Base Sepolia, and no-shows read from the escrow refunds. Lena's finance agent itself is on Sokosumi as a Coworker (below).

**Why Cardano**, in the workshop's four properties: *payments with rules*, since the fee waits in Masumi's escrow until the Keeper delivers; *native stablecoins*, since tUSDM moves like ADA with no token contract in the path; *deterministic transactions*, since Lena's agent checks the exact payment before it signs (seller, amount, escrow); *non-custodial facilitator*, since it only verifies and relays the signed transaction.

**A paid task on preprod, end to end** (Sat 31 Oct, 03:01–03:07 CET; older runs: [app README, Evidence](cardano/apps/payonproof/README.md#evidence)):

| What | Transaction |
|---|---|
| Lena's agent chooses Keeper Swift (1 tUSDM, 7 verified executions) and locks its fee in Masumi escrow (INV-18) | [`75e46582…`](https://preprod.cardanoscan.io/transaction/75e465822791e14cb240c446cb3a7666268ecac18dc3135520db73f39d097eb5) |
| Swift buys a second signed EUR/USD over x402 (0.01 aUSD), then executes INV-18 on Base Sepolia: 446.53 dUSD to the supplier | [`0x044561b5…`](https://sepolia.basescan.org/tx/0x044561b504a2021f144fb6006c980882751a997dd29da0c8bacffdf6fd8ed422), [`0x1758f8f7…`](https://sepolia.basescan.org/tx/0x1758f8f7bc1be272ba4e913afd3035c3eb3904f8dfb20248694d718cf8f4b06e) |
| Swift puts the result hash into the escrow | [`5e979434…`](https://preprod.cardanoscan.io/transaction/5e979434207d9e9bf134739c94e0afeb4bbbae6f81a19903cd74f314db5acc5e) |
| Swift's receipt (CIP-20; `npm run check` verifies it on both chains) | [`e02045b8…`](https://preprod.cardanoscan.io/transaction/e02045b8777435086b22fdd615b8379688d94d01dbe073d591b1c814a4bf304f) |
| INV-17's limit was never reached: Swift authorizes the refund, Lena withdraws her fee | [`e422fbe5…`](https://preprod.cardanoscan.io/transaction/e422fbe5ecfacb8b877be98dbb3cacecfe8dfa7c4708ed88fb89e720a0fb8d86), [`3a07af8a…`](https://preprod.cardanoscan.io/transaction/3a07af8a94e7fbe731cddb05fc5d808143033f28c429161b92be67366538fa9a) |
| After Lena's dispute window, Swift collects its fee (Withdraw) | [`1e45c3d4…`](https://preprod.cardanoscan.io/transaction/1e45c3d4147332336b12d658e0f413b92417963b126513e98fb583093fc2b940) |
| `--vanish` (earlier run): the Keeper takes the lock [`41f3659c…`](https://preprod.cardanoscan.io/transaction/41f3659cdedab12ff2ecddc28df97920fb8068808c4fe1f80bd4cf4cf2c4b008) and disappears; Lena refunds after the deadline | [`b903d2c3…`](https://preprod.cardanoscan.io/transaction/b903d2c30068d2ae1d897e7ab2e3ab5e05241030d0077ef42d81631713bba2ed) |
| Per-attempt x402 fee (earlier run), settled only after the invoice was paid | [`22639574…`](https://preprod.cardanoscan.io/transaction/226395746c8076b5e5fd3279cfd6287d525ef2440582459bd8e9283e83e69c7f) |

**On Sokosumi** (Sat 31 Oct, 04:49 CET): a team in the TUM-Hackathon Workspace posted Task `01a19013-9dd6-746e-81c8-edda7b120763` to the Coworker `01a1900c-8cc4-75cf-8c54-30a0161eac48` ("PayOnProof finance agent", vendor PayOnProof): *"Pay Fazenda Alta invoice INV-20, €400, as soon as EUR/USD is under 1.13; deadline November 20."* The Coworker posted a progress comment with the fee lock [`d7037485…`](https://preprod.cardanoscan.io/transaction/d7037485f0aeb6181264ad1d54a6cded66197dfe7e7599ec26472ea717b82fe4), then completed the Task with every step and link: order [`0x67770c22…`](https://sepolia.basescan.org/tx/0x67770c2220a86ff17c49b3eb08bec9bbd6c023be10f51b1520e08f715ab8d66c), second rate over x402 [`0x252cb143…`](https://sepolia.basescan.org/tx/0x252cb143ff26c478121ad62682a39585eac3471415fce0e3923403e557de6c70), payment of 446.53 dUSD [`0x02e505a6…`](https://sepolia.basescan.org/tx/0x02e505a6cde1771c59dc2e9be67b0e27b3f5d048d24b20f7ead02bc7f9c5316e), result hash [`b200508e…`](https://preprod.cardanoscan.io/transaction/b200508e8f1386b63f8f5432f34616243cc031718c8ead17bc838ff081deaa35), receipt [`232099ae…`](https://preprod.cardanoscan.io/transaction/232099ae8e655b54fc161f789e9de6ecf4672c1aba3126f358691e1905147a6c). A follow-up comment (*"At what exchange rate was the supplier paid, and when does the Keeper get its fee? How can I verify the payment myself?"*) was answered in 9 seconds from the job's facts.

## For API3 judges

The workshop's question was *which data did your agent act on?* Here a Keeper may only move Lena's money with an EUR/USD rate it chose from AirnodeHub, signed by Nodary, and checked by the contract that holds the money: signer, request, time, then the limit. The contract has the last word.

| Judging | Where to look |
|---|---|
| Real use case (40) | Cross-border invoices for small importers: pay when the rate is right, with the money in an escrow that can only pay that supplier. |
| Signed data matters (30) | The signed rate decides whether the invoice is paid and how much the supplier gets (`€ × rate`). A forged rate underpays the supplier or pays at a rate Lena refused ([what forgery would do](docs/SUBMISSION.md#api3-questions)). |
| Execution (20) | `InvoiceEscrow` verifies with `AirnodeV2Attestation.verify`, projected `{price, updatedAt}` fields, 12 InvoiceEscrow tests, tamper test on the deployed contract (below). |
| Novelty (10) | Two chains, one job: the payment on Base Sepolia is what releases the Keeper's fee on Cardano, through a result hash anyone can recheck. |
| Autonomous agent (+10) | Keepers loop on their own over several invoices and rounds (`autopilot`), and buy a second signed rate over x402 before they move money. |

- **Network:** Base Sepolia (chain id 84532).
- **Contract:** InvoiceEscrow [`0x63e2b722725eda487a9d76962ef4633dcc5e571a`](https://sepolia.basescan.org/address/0x63e2b722725eda487a9d76962ef4633dcc5e571a) ([source](api3/contracts/payonproof/InvoiceEscrow.sol)); demo stablecoin DemoUSD [`0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf`](https://sepolia.basescan.org/address/0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf).
- **What it checks before paying:** signer = Nodary Airnode v2 `0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0`; request hash = the EUR/USD request (`0x5ccc3aa9…d3d0`); response signed ≤ 5 minutes ago; rate taken ≤ 3 days ago (FX closes on weekends); rate below the order's limit; order open and before its deadline; each order pays once.
- **What the signed value drives:** whether the invoice is paid and how much the supplier receives (`€ amount × signed rate`); the rest of the deposit goes back to the payer.
- **Tamper test** (in the video, and runnable by anyone with Base Sepolia gas): `npm run tamper -w apps/payonproof` opens an order, then shows four responses rejected by the contract (one value edited, too old, another request, another signer) and one valid, fresh response executing it. Last run (Sat 31 Oct, 03:10 CET): the four were rejected with `NotSignedByAirnode`, `ResponseTooOld`, `NotSignedByAirnode` (BTC/USD request) and `NotSignedByAirnode` (another key); the valid response executed [`0x27fe4dd7…`](https://sepolia.basescan.org/tx/0x27fe4dd7dd2eace19294931b8f5b0792ecf70d06a6eb80cd64da13f57e50a634).
- **Submit your own response:** in `api3/`, `pnpm --silent fetch-response EUR/USD > response.json` (or write one by hand: `{ "timestamp", "data", "signature" }`), then in `cardano/`, `npm run tamper -w apps/payonproof -- --file ../api3/response.json`. The script dry-runs it against the deployed contract (no gas) and prints ACCEPTED or the contract's error.
- **Autonomous, multi-cycle:** `npm run autopilot -w apps/payonproof` runs several invoices over several rounds; each Keeper loops on its own (signed rate → compare → execute when the limit holds), leaving one `InvoicePaid` event per execution. Last run: 6 invoices over 3 rounds, 5 executed ([table](cardano/apps/payonproof/README.md#evidence)).
- **Pays for data over x402 when it matters:** before it moves money, a Keeper buys a second signed EUR/USD from Frankfurter on AirnodeHub (`getRate`, 0.01 aUSD on Base Sepolia, x402 `exact`), checks its signer and request hash, and executes only if both sources agree within 1 % (e.g. aUSD payment [`0x044561b5…`](https://sepolia.basescan.org/tx/0x044561b504a2021f144fb6006c980882751a997dd29da0c8bacffdf6fd8ed422), 0.09 % apart, then execute [`0x1758f8f7…`](https://sepolia.basescan.org/tx/0x1758f8f7bc1be272ba4e913afd3035c3eb3904f8dfb20248694d718cf8f4b06e)).
- Contract tests: `cd api3 && forge test` (InvoiceEscrow tests include the four tamper cases on a real Nodary response).

Who relies on the data, what a forged value would do, and the data we wanted but did not find: [docs/SUBMISSION.md](docs/SUBMISSION.md#api3-questions).

## Setup and run

Requires Node.js 22+, [Foundry](https://getfoundry.sh) and pnpm (for `api3/`), a free [Blockfrost](https://blockfrost.io) preprod project id and an [Anthropic API key](https://console.anthropic.com).

```sh
git clone --recurse-submodules https://github.com/Curious-Charlie/tum-blockchain-hackathon.git
cd tum-blockchain-hackathon/api3 && pnpm install && forge test
cp .env.example .env                         # PRIVATE_KEY of a Base Sepolia account with a little ETH, RPC_URL
cd ../cardano && npm install
cp .env.example .env                         # BLOCKFROST_PROJECT_ID, ANTHROPIC_API_KEY; then `npm run wallets` creates the treasury
npm run wallets -w apps/payonproof           # creates Lena's and the Keepers' wallets, prints their addresses
```

Fund **Lena's** Cardano address at the [Masumi dispenser](https://dispenser.masumi.network) (Testnet, 100 tADA + 100 tUSDM) and give each Keeper some tADA (`npm run wallets -w apps/payonproof -- --fund` tops up from the treasury). `npm run keepers -w apps/payonproof -- --fund-eth` sends each Keeper's EVM account 0.00003 ETH for gas from `PRIVATE_KEY`. Then:

```sh
npm run dashboard                                    # terminal 1: live dashboard on http://127.0.0.1:4000
npm run demo -w apps/payonproof                      # terminal 2: two invoices, Keeper fees in Masumi escrow (~5 min)
npm run escrow -w apps/payonproof -- finish --wait   # Keepers collect after the unlock time; refunds when due
npm run check -w apps/payonproof -- <receipt tx>     # check a Keeper's receipt against both chains
npm run tamper -w apps/payonproof                    # API3 tamper test
npm run demo -w apps/payonproof -- --x402            # per-attempt mode: fee charged only on success
npm run demo -w apps/payonproof -- --evm anvil       # no Base Sepolia ETH: same contracts on a local anvil chain
```

Details, options and the 60-second demo script: [`cardano/apps/payonproof/README.md`](cardano/apps/payonproof/README.md).

## Honest limitations

The per-attempt x402 fee sits signed but unsubmitted in the Keeper's hands for up to 10 minutes and could be double-spent; Masumi escrow (the default) removes that, at the cost of a 32-minute wait before the Keeper collects. The escrow stores the Keeper's result hash but cannot check it against Base Sepolia; anyone can (`npm run check`). Keeper records come only from chain data and count only deliveries. Nodary's EUR/USD can freeze over the weekend; the contract accepts a rate up to 3 days old (checked after Friday's close: the demo and the tamper test still pass, at Friday's last rate; [details](cardano/apps/payonproof/README.md#weekend-fx)). Full list: [docs/LIMITATIONS.md](docs/LIMITATIONS.md) ([中文](docs/LIMITATIONS.zh.md)).

## Repository layout

| Path | What it is |
|---|---|
| [`cardano/apps/payonproof/`](cardano/apps/payonproof/) | PayOnProof: Lena's finance agent, three Keepers, demo, autopilot, escrow and check commands |
| [`cardano/packages/core/`](cardano/packages/core/) | Shared infrastructure: role wallets, x402 seller kit, Masumi escrow, paying only an accepted offer, market (quotes and choice), CIP-20 publishing, Claude helpers, live dashboard |
| [`api3/`](api3/) | Foundry project (from the AirnodeHub hackathon starter, MIT): `InvoiceEscrow`, `DemoUSD`, tests, response scripts |
| [`sokosumi/`](sokosumi/) | Sokosumi CLI 1.0.4 (Node 24), setup of the "PayOnProof finance agent" Coworker, `runtime.mjs` for Task comments |
| [`film/`](film/) | The demo video as code: designed scenes, a synthesized techno soundtrack, real transactions |
| [`docs/`](docs/) | Limitations, submission text, design notes and track rules |

## Team

CURIOUSCHARLIE (solo), built with Claude Code.
