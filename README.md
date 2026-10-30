# PayOnProof: agents that pay invoices on signed FX rates, and get paid only on proof

> Submission for the [TUM Blockchain & AI Hackathon 2026](https://hackathon.tum-blockchain.com/) (Munich, 30–31 October 2026).
> **Tracks:** Cardano (Agentic Commerce on Cardano) · API3 (Any API in your contract)

**Demo video:** TBD

Lena runs a small coffee roastery in Munich. Her suppliers in Colombia and Brazil invoice her in euros; she holds US dollar stablecoins and wants to pay **when EUR/USD drops below her limit**, without watching the market. She tells her finance agent in one sentence. The agent locks the invoice money in an escrow contract and hires a **Keeper agent** that watches the rate and executes the payment.

- **The rate is signed data, checked by the contract.** The Keeper submits an EUR/USD rate **signed by the Nodary Airnode (API3 AirnodeHub)**. `InvoiceEscrow` on Base Sepolia checks the signer, that it answers exactly the EUR/USD request, that it is fresh, and that it is below Lena's limit, then pays the supplier `€ amount × signed rate` and refunds the rest. The Keeper can trigger the payment, never redirect it.
- **The Keeper is paid on proof.** Lena's agent locks the Keeper's fee in **Masumi escrow on Cardano** before the work. After executing, the Keeper puts a result hash into the escrow that binds the fee to the `execute` transaction and its `InvoicePaid` event, and collects after Lena's dispute window. No execution → refund.
- **The buyer agent chooses whom to pay.** Three Keepers offer the job at different prices. Lena's agent reads each Keeper's record from the chains (receipts on Cardano, verified against Base Sepolia) and picks the cheapest acceptable one within its **AgentGuard** budget, explaining why on a live dashboard.
- **AI interprets, deterministic checks gate money.** Claude turns Lena's sentence into an order; code checks every field and takes the supplier's address from her address book. Contracts and code decide every payment.

```
Lena's finance agent ── order + deposit ─────────────────────────────▶ InvoiceEscrow            [Base Sepolia]
   │ asks 3 Keepers for a price, checks their records on chain
   │ AgentGuard: allowlisted payees, per-payment / per-invoice / daily caps
   └── Keeper fee, x402 → Masumi escrow lock ─────────────────────────▶ Masumi escrow             [Cardano preprod]
                                Keeper: Nodary-signed EUR/USD each cycle
                                rate < limit ─▶ InvoiceEscrow.execute(order, signed response) ─▶ supplier paid
                                result hash ─▶ escrow; receipt (CIP-20) ─▶ collects after the unlock time
                                never met ─▶ authorizes a refund ─▶ Lena withdraws her fee
```

## For Cardano judges

| | |
|---|---|
| **Customer and task** | Small importers and exporters paying cross-border invoices: "pay when the rate is right" as a paid agent job. The Keeper earns a fee per executed invoice and nothing for watching. |
| **Seller** (x402) | Three Keepers sell "watch this order and execute it" over x402 on Cardano preprod (Atlas 2 tUSDM, Swift 1 tUSDM, Prime 4 tUSDM), paid into Masumi escrow; or per attempt in tADA, charged only on success (`--x402`). |
| **Buyer** | Lena's agent compares quotes and on-chain records in code and pays only the chosen Keeper, through AgentGuard (payee allowlist, caps, audit log, kill switch). |
| **Coworker** (Masumi) | The fee is locked before the work and released after delivery (SubmitResult → Withdraw), or refunded (AuthorizeRefund → WithdrawRefund, or after the deadline). |
| **Cardano tools** | x402 on preprod (`@x402/cardano`, `@x402/express`, `@x402/fetch`) with an in-process facilitator; Masumi escrow (`vested_pay` V2) via x402 `assetTransferMethod: "masumi"` plus SubmitResult, Withdraw, AuthorizeRefund and WithdrawRefund built with evolution-sdk; tUSDM and tADA; CIP-20 metadata (label 674) for the Keepers' receipts; Blockfrost. |

**Paid tasks on preprod** (all transactions: [app README, Evidence](cardano/apps/payonproof/README.md#evidence)):

| What | Transaction |
|---|---|
| Lena locks Keeper Atlas's 2 tUSDM fee in Masumi escrow (INV-18) | [`adcbd6fc…`](https://preprod.cardanoscan.io/transaction/adcbd6fc3d078d233e1ff462ac90695dd3a394a5c065f77fb8bf22cfd2cad652) |
| Atlas executes INV-18 on Base Sepolia, 446.70 dUSD to the supplier | [`0xe66ff958…`](https://sepolia.basescan.org/tx/0xe66ff9582763a1a74b0bdb8865ce6a319e28ad92e194faeb7c2c7e75be08d38c) |
| Atlas puts the result hash into the escrow | [`8d18c05e…`](https://preprod.cardanoscan.io/transaction/8d18c05eca703f424efb687c90a6df182fb1ba6a040b87afbfe72eb6900ec0e2) |
| Atlas's receipt (CIP-20; `npm run check` verifies it on both chains) | [`5e5a0eff…`](https://preprod.cardanoscan.io/transaction/5e5a0eff49ab64355fa06eb79e6b0000c82a7a3279de44143a592eb87229bba3) |
| INV-17's limit was never reached: Atlas authorizes the refund, Lena withdraws | [`3778343d…`](https://preprod.cardanoscan.io/transaction/3778343d6685fe19662d82a94c59454ee8f6c6b0d10dcc308e9f1bee10937bf0), [`2e0105a5…`](https://preprod.cardanoscan.io/transaction/2e0105a5d83aac9b3ac7509ecdbf933191f7d1e3d1b3e22277862999bfd654b1) |
| 32 minutes after the quote, Atlas collects its fee (Withdraw) | [`27572169…`](https://preprod.cardanoscan.io/transaction/275721698939e368cc9bc4ab9be8e295ea351d553c541e17a1fc0d8cbafedb39) |
| `--vanish`: the Keeper takes the lock [`41f3659c…`](https://preprod.cardanoscan.io/transaction/41f3659cdedab12ff2ecddc28df97920fb8068808c4fe1f80bd4cf4cf2c4b008) and disappears; Lena refunds after the deadline | [`b903d2c3…`](https://preprod.cardanoscan.io/transaction/b903d2c30068d2ae1d897e7ab2e3ab5e05241030d0077ef42d81631713bba2ed) |
| Per-attempt x402 fee, settled only after the invoice was paid | [`22639574…`](https://preprod.cardanoscan.io/transaction/226395746c8076b5e5fd3279cfd6287d525ef2440582459bd8e9283e83e69c7f) |

## For API3 judges

- **Network:** Base Sepolia (chain id 84532).
- **Contract:** InvoiceEscrow [`0x63e2b722725eda487a9d76962ef4633dcc5e571a`](https://sepolia.basescan.org/address/0x63e2b722725eda487a9d76962ef4633dcc5e571a) ([source](api3/contracts/payonproof/InvoiceEscrow.sol)); demo stablecoin DemoUSD [`0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf`](https://sepolia.basescan.org/address/0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf).
- **What it checks before paying:** signer = Nodary Airnode v2 `0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0`; request hash = the EUR/USD request (`0x5ccc3aa9…d3d0`); response signed ≤ 5 minutes ago; rate taken ≤ 3 days ago (FX closes on weekends); rate below the order's limit; order open and before its deadline; each order pays once.
- **What the signed value drives:** whether the invoice is paid and how much the supplier receives (`€ amount × signed rate`); the rest of the deposit goes back to the payer.
- **Tamper test** (in the video, and runnable by anyone with Base Sepolia gas): `npm run tamper -w apps/payonproof` opens an order, then shows four responses rejected by the contract (one value edited, too old, another request, another signer) and one valid, fresh response executing it. Last run: valid response executed [`0xc023058f…`](https://sepolia.basescan.org/tx/0xc023058f9b1ba13da7325bc9c6a1ae3013ce756f124639eb4d2827a295e164fb).
- **Submit your own response:** in `api3/`, `pnpm --silent fetch-response EUR/USD > response.json` (or write one by hand: `{ "timestamp", "data", "signature" }`), then in `cardano/`, `npm run tamper -w apps/payonproof -- --file ../api3/response.json`. The script dry-runs it against the deployed contract (no gas) and prints ACCEPTED or the contract's error.
- **Autonomous, multi-cycle:** `npm run autopilot -w apps/payonproof` runs several invoices over several rounds; each Keeper loops on its own (signed rate → compare → execute when the limit holds), leaving one `InvoicePaid` event per execution. Last run: 6 invoices over 3 rounds, 5 executed ([table](cardano/apps/payonproof/README.md#evidence)).
- **Pays for data over x402 when it matters:** before it moves money, a Keeper buys a second signed EUR/USD from Frankfurter on AirnodeHub (`getRate`, 0.01 aUSD on Base Sepolia, x402 `exact`), checks its signer and request hash, and executes only if both sources agree within 1 % (e.g. aUSD payment [`0xf4e9adf9…`](https://sepolia.basescan.org/tx/0xf4e9adf9482e3ea98385e5704ff3fe365e92e5d63e7bf8a5c715c104a0114b06), then execute [`0x33d78b68…`](https://sepolia.basescan.org/tx/0x33d78b680c8e4013de0ce4cd3f2e4cd32f12795fb50b1516f13133a2ed5d67c7)).
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
| [`cardano/packages/core/`](cardano/packages/core/) | Shared infrastructure: role wallets, x402 seller kit, Masumi escrow, AgentGuard, market (quotes and choice), CIP-20 publishing, Claude helpers, live dashboard |
| [`api3/`](api3/) | Foundry project (from the AirnodeHub hackathon starter, MIT): `InvoiceEscrow`, `DemoUSD`, tests, response scripts |
| [`docs/`](docs/) | Limitations, submission text, design notes and track rules |

## Team

CURIOUSCHARLIE (solo), built with Claude Code.
