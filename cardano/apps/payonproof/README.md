# D1 PayOnProof: a Keeper agent that is paid only when it actually pays your invoice

> *Don't trust your agent. Verify it.*

Lena runs a small coffee roastery in Munich. Her Colombian supplier invoices her **€1,000**, but she holds US dollar stablecoins. She wants to pay **when EUR/USD drops below 1.11**, without watching the market. She tells her finance agent in one sentence; the agent hires a **Keeper agent** that watches the rate and executes the payment.

Three trust problems, three answers:

| Worry | Answer | Where |
|---|---|---|
| Will the Keeper fake the rate or steal the money? | The invoice money sits in an escrow contract on Base Sepolia. It pays only the supplier fixed in the order, only on an EUR/USD rate **signed by the Nodary Airnode (API3)**, fresh, for exactly this request, and below Lena's limit. The Keeper can trigger the payment, never redirect it. | `api3/contracts/payonproof/InvoiceEscrow.sol` (EVM) |
| Will the Keeper get paid for work it did not do? | Lena's agent locks the Keeper's fee in **Masumi escrow on Cardano** before the Keeper starts. The Keeper collects only after it puts a **result hash** into the escrow that binds the fee to the `execute` transaction and its `InvoicePaid` event; if the condition never holds it authorizes a refund, and if it vanishes Lena takes the fee back after the deadline. | `keeper.ts`, `proof.ts`, `@agentic/core/escrow` |
| Which Keeper should she trust with the job? | Her agent asks every Keeper for a price and checks its **track record on chain**: receipts on Cardano, each verified against Base Sepolia. Code picks the cheapest acceptable Keeper within **AgentGuard**'s caps and explains every choice. | `lena.ts`, `records.ts`, `@agentic/core/market` |

**AI interprets, deterministic checks gate money.** Claude (Haiku) turns Lena's sentence into a structured order; plain code validates every field and takes the supplier's address from Lena's own address book. Whether money moves is decided by the contracts (signed rate vs. limit; Masumi's escrow rules) and by code (AgentGuard, the Keeper choice).

### Seller, Buyer, Coworker

| | In PayOnProof |
|---|---|
| **Seller** (x402) | Three Keepers sell the same job over x402 on Cardano preprod at different prices (Atlas 2 tUSDM, Swift 1 tUSDM, Prime 4 tUSDM): "watch this order and execute it", paid into Masumi escrow; or per attempt in tADA, charged only on success (`--x402`). |
| **Buyer** | Lena's finance agent asks each Keeper for its x402 quote, checks its proof of which EVM account it executes from and its on-chain record, and decides in code: within AgentGuard's caps, no false receipts, at least 2 verified executions for invoices above €250 (new Keepers start with small ones), cheapest wins. Every reason goes to the dashboard. |
| **Coworker** (Masumi) | The fee is locked before the work and released after delivery. Two agents on two chains: the Keeper's execution on Base Sepolia is what releases its pay on Cardano, through the result hash. |

## How one job works (escrow mode, the default)

```
Lena's finance agent                                     Keeper (chosen by code)                       chains
 "Pay INV-18, €400, when EUR/USD < 1.13"
 Claude → order; code checks it ──────────────────────────────────────────────────▶ InvoiceEscrow.createOrder   [Base Sepolia]
 asks 3 Keepers for a price, reads their records ──▶ quotes (x402 402)
 AgentGuard: payee = a Keeper, ≤ 3 tUSDM per invoice
 locks the fee ─────────── x402, assetTransferMethod "masumi" ─────────────────────▶ Masumi escrow lock          [Cardano preprod]
                                                         checks the lock against the terms it signed
                                                         every cycle: Nodary-signed EUR/USD (API3)
                                                         rate < limit? ─▶ InvoiceEscrow.execute ──────▶ pays the supplier   [Base Sepolia]
                                                         result hash = sha256(execute tx, InvoicePaid, lock)
                                                         SubmitResult ───────────────────────────────▶ hash in the escrow  [Cardano preprod]
                                                         receipt (CIP-20) ───────────────────────────▶ public track record
                                                         after the unlock time: collect the fee
                         condition never held in the watch window ─▶ AuthorizeRefund ─▶ Lena withdraws her fee at once
                         Keeper vanished ─▶ Lena withdraws after the result deadline
```

The contract repeats every check the Keeper makes off chain: signer (`0xE70f…E4c0`, Nodary), request hash (EUR/USD), response signed ≤ 5 minutes ago, rate taken ≤ 3 days ago, rate below the order's limit, order still open. Each order pays once.

## Roles and wallets

| Role | Agent | Wallets |
|---|---|---|
| `LENA` | Lena's finance agent | Cardano (locks Keeper fees through AgentGuard); EVM treasury = `api3/.env` `PRIVATE_KEY` (locks invoices in the InvoiceEscrow) |
| `KEEPER` | Keeper Atlas, 2 tUSDM per job | Cardano (earns fees, pays escrow and receipt transactions); EVM `KEEPER_EVM_PRIVATE_KEY` (gas for `execute`) |
| `KEEPER_B` | Keeper Swift, 1 tUSDM per job | same, `KEEPER_B_EVM_PRIVATE_KEY` |
| `KEEPER_C` | Keeper Prime, 4 tUSDM per job | same, `KEEPER_C_EVM_PRIVATE_KEY` |
| — | Café Verde, Fazenda Alta | suppliers' EVM addresses in Lena's address book (`lena.ts`) |

Ports: Keepers 4110, 4112, 4113; look-alike Keeper (`--attack`) 4111; local anvil fallback 4118.

## Setup and run

Needs Node 22+, Foundry (`forge`, `anvil`), `cardano/.env` (Blockfrost, Anthropic key), this app's `.env` (role mnemonics; `npm run wallets -w apps/payonproof` creates them, EVM keys are created on first use) and `api3/.env` (`PRIVATE_KEY`, `RPC_URL` for Base Sepolia).

```sh
cd cardano && npm install
cd ../api3 && git submodule update --init --recursive && forge test   # escrow tests incl. the 4 tamper cases
cd ../cardano
npm run dashboard                                    # terminal 1: http://127.0.0.1:4000
npm run wallets -w apps/payonproof -- --fund         # LENA needs tADA + tUSDM (Masumi dispenser or the treasury); Keepers need tADA
npm run keepers -w apps/payonproof -- --fund-eth     # each Keeper's EVM gas (0.00003 ETH) and its record on chain
npm run demo -w apps/payonproof                      # terminal 2: escrow mode, two invoices, ~5 minutes
npm run escrow -w apps/payonproof -- finish --wait   # Keepers collect after the unlock time, Lena refunds what is due
npm run check -w apps/payonproof -- <receipt tx>     # anyone: check a Keeper's receipt against both chains
npm run tamper -w apps/payonproof                    # API3 tamper test: 1 valid + 4 rejected responses
```

Demo options: `--watch 2` (minutes a Keeper watches before it gives the fee back), `--interval 12` (seconds between checks), `--vanish` (the Keepers take the lock and disappear: refund after the deadline), `--limit-a 1.11 --limit-b 1.13` (defaults: just below and just above the live rate, so both paths show), `--evm base-sepolia|anvil`.

Per-attempt mode, kept as an option: `npm run demo -w apps/payonproof -- --x402` hires Keeper Atlas per attempt with a signed 2 tADA fee; a check whose condition is not met answers 409 and the fee is never submitted. Add `--attack` to show AgentGuard refusing a look-alike Keeper from a phishing message.

**Autopilot** (several invoices and cycles, no human in the loop): `npm run autopilot -w apps/payonproof -- --rounds 3 --every 4 --watch 3`. Every round two new invoices arrive; Lena's agent picks a Keeper for each and locks its fee; the Keepers loop on their own (signed rate → compare → execute when the limit holds). Each execution adds a receipt that the next round's choice reads, so a new Keeper that delivers small invoices earns the record it needs for larger ones.

**EVM network.** The escrow is deployed on **Base Sepolia** (addresses in `deployments.json`); the demo, autopilot and tamper test use it by default. `--evm anvil` (or `EVM_NETWORK=anvil`) starts a local anvil chain on port 4118, deploys the same contracts and runs against them. Cardano is always real preprod. To deploy afresh: `npm run deploy -w apps/payonproof -- --dry-run`, then without `--dry-run`.

## 60-second demo script

Before: dashboard open at http://127.0.0.1:4000 (Reset it), a terminal in `cardano/`, the INV-18 collect transaction from an earlier run open in a browser tab (collecting needs 32 minutes, so it is shown, not waited for). Start `npm run demo -w apps/payonproof` about a minute before you begin: the locks need Cardano confirmations.

| Time | Say | Show / do |
|---|---|---|
| 0:00 | "Lena runs a coffee roastery in Munich. She owes her supplier €400 and wants to pay when EUR/USD is below 1.13, without watching charts. Her finance agent writes the order and locks the money in an escrow contract that can only ever pay that supplier." | Timeline: "Claude read it as INV-18 …"; blue arrow Lena → Invoice escrow (basescan link). |
| 0:12 | "Now it hires a Keeper. Three offer the job. Swift is cheapest but has no record on chain, Prime is over Lena's budget, Atlas has verified executions: its receipts on Cardano match real payments on Base Sepolia. Code picks Atlas." | The three ✓/✗ lines with their reasons. |
| 0:25 | "Lena's agent locks Atlas's fee in Masumi escrow on Cardano. Atlas can see the money is there, Lena can't take it back while Atlas works." | 🔒 edge Lena → Masumi escrow; cardanoscan link of the lock. |
| 0:35 | "Atlas checks the API3-signed rate: 1.117, below 1.13. It hands the signed rate to the contract, which checks signer, freshness and limit itself and pays the supplier." | Invoice escrow → Fazenda Alta; "INV-18 paid …" (basescan). |
| 0:45 | "Then Atlas puts a hash into the escrow that binds its fee to that exact payment, and publishes a receipt. 32 minutes later, after Lena's dispute window, it collects." | "Result hash … into the Masumi escrow"; open the earlier collect transaction. |
| 0:55 | "INV-17's limit was never reached, so its Keeper gave the fee back. Pay on proof: the agent can't fake the data, can't take the money, and only earns when it delivered." | "Refund authorized … Lena took its 2 tUSDM back". |

For API3 judges: `npm run tamper -w apps/payonproof` opens an order, shows the four tampered responses (edited value, too old, another request, another signer) rejected by the contract, then one valid, fresh response executing it. Bring your own response with `-- --file response.json` (`pnpm --silent fetch-response EUR/USD > response.json` in `api3/`).

## Evidence

**Base Sepolia** (chain 84532): InvoiceEscrow [`0x63e2b722725eda487a9d76962ef4633dcc5e571a`](https://sepolia.basescan.org/address/0x63e2b722725eda487a9d76962ef4633dcc5e571a) (deploy tx [`0x37a2b603…`](https://sepolia.basescan.org/tx/0x37a2b6030c8991943cbddfc291d106b97d5ec4682e04d94a896c9c8f050c37c4)), request hash `0x5ccc3aa9…d3d0` (Nodary EUR/USD), `maxRateAge` 3 days; DemoUSD (dUSD, 6 decimals) [`0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf`](https://sepolia.basescan.org/address/0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf).

**Escrow run, 2026-10-30 17:03** (Keeper Atlas chosen for both invoices; Swift rejected for lack of record, Prime over the cap):

| Step | Transaction |
|---|---|
| INV-18: Lena locks 452 dUSD in InvoiceEscrow (order 10) | [`0xa33949ee…`](https://sepolia.basescan.org/tx/0xa33949eef1288030547de8d4b1c1d02a78634b9d247777d5113f005e2aeabb19) |
| INV-18: Lena locks Atlas's 2 tUSDM fee in Masumi escrow | [`adcbd6fc…`](https://preprod.cardanoscan.io/transaction/adcbd6fc3d078d233e1ff462ac90695dd3a394a5c065f77fb8bf22cfd2cad652) |
| INV-18: Atlas executes at the signed EUR/USD 1.11675, 446.70 dUSD to the supplier | [`0xe66ff958…`](https://sepolia.basescan.org/tx/0xe66ff9582763a1a74b0bdb8865ce6a319e28ad92e194faeb7c2c7e75be08d38c) |
| INV-18: result hash `85712348…` into the escrow (SubmitResult) | [`8d18c05e…`](https://preprod.cardanoscan.io/transaction/8d18c05eca703f424efb687c90a6df182fb1ba6a040b87afbfe72eb6900ec0e2) |
| INV-18: Atlas's receipt (CIP-20; `npm run check` passes on both chains) | [`5e5a0eff…`](https://preprod.cardanoscan.io/transaction/5e5a0eff49ab64355fa06eb79e6b0000c82a7a3279de44143a592eb87229bba3) |
| INV-17: Lena locks 1,110 dUSD (order 9) and Atlas's fee | [`0x14abed29…`](https://sepolia.basescan.org/tx/0x14abed2903456eb453b42887397233b84243bd20a10b63f9691c32756be2fbb8), [`2e501ed9…`](https://preprod.cardanoscan.io/transaction/2e501ed977dd98727113199a91b547eaa405b9df840d02301b3f5d7b9a77a549) |
| INV-17: EUR/USD stayed above 1.11 for 10 cycles; Atlas authorizes the refund | [`3778343d…`](https://preprod.cardanoscan.io/transaction/3778343d6685fe19662d82a94c59454ee8f6c6b0d10dcc308e9f1bee10937bf0) |
| INV-17: Lena withdraws her 2 tUSDM | [`2e0105a5…`](https://preprod.cardanoscan.io/transaction/2e0105a5d83aac9b3ac7509ecdbf933191f7d1e3d1b3e22277862999bfd654b1) |

**Per-attempt x402 run, 2026-10-30 16:55** (fee settles only after the escrow paid): INV-18 executed [`0x69c789f0…`](https://sepolia.basescan.org/tx/0x69c789f0e3065fdf554912503ca0c45089f17feaf93ab92f692b7fb548d3a982), fee 2 tADA [`22639574…`](https://preprod.cardanoscan.io/transaction/226395746c8076b5e5fd3279cfd6287d525ef2440582459bd8e9283e83e69c7f), receipt [`9dbd3060…`](https://preprod.cardanoscan.io/transaction/9dbd306022e5e379de1fcb85a516bc97d6965f9980fbfa80e780365e948795ad). Attempts whose condition was not met: HTTP 409, no transaction exists (`cardano/.audit/payonproof-lena.jsonl`, decision `voided`). Earlier runs: fee [`4a5300fe…`](https://preprod.cardanoscan.io/transaction/4a5300fe0927359c8c1ab84e32befb86e3b14296c4be7e2139cd3c5b754d1534) with receipt [`d578fe53…`](https://preprod.cardanoscan.io/transaction/d578fe53cd06c3c1d50acba2ee244ee61cc378c5527ec9cf4efd6d0d45dfc7df), fee [`d5477e11…`](https://preprod.cardanoscan.io/transaction/d5477e116ecff63a33cf6b340feebc9c869604c03d0748576db70b431191a3d5) with receipt [`3c9017a0…`](https://preprod.cardanoscan.io/transaction/3c9017a0ee8b8c68e62dd3c197bfb0ad8e670e7b90f0fb141de1332dfd850fde).

**Tamper test, 2026-10-30 17:00**: edited value, too old, another request (BTC/USD) and another signer rejected by the contract (`NotSignedByAirnode`, `ResponseTooOld`); the valid response executed [`0xc023058f…`](https://sepolia.basescan.org/tx/0xc023058f9b1ba13da7325bc9c6a1ae3013ce756f124639eb4d2827a295e164fb).

## Weekend FX

Nodary's EUR/USD may stop updating once FX markets close on Friday evening. The escrow accepts a rate up to 3 days old, while the signed response itself must be at most 5 minutes old. Check after the close: to be run Friday after 23:15 CET.

## Limits

See [docs/LIMITATIONS.md](../../../docs/LIMITATIONS.md) ([中文](../../../docs/LIMITATIONS.zh.md)): the per-attempt fee is held by the Keeper and could be double-spent (fixed by escrow, now the default); escrow waits 32 minutes before the Keeper collects and does not itself check the result hash; Keeper records count only deliveries; weekend FX; Nodary is still trusted for the value.
