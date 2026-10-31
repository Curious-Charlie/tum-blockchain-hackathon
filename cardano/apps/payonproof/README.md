# D1 PayOnProof: a Keeper agent that is paid only when it actually pays your invoice

> *Don't trust your agent. Verify it.*

Lena runs a small coffee roastery in Munich. Her Colombian supplier invoices her **€1,000**, but she holds US dollar stablecoins. She wants to pay **when EUR/USD drops below 1.11**, without watching the market. She tells her finance agent in one sentence; the agent hires a **Keeper agent** that watches the rate and executes the payment.

Three trust problems, three answers:

| Worry | Answer | Where |
|---|---|---|
| Will the Keeper fake the rate or steal the money? | The invoice money sits in an escrow contract on Base Sepolia. It pays only the supplier fixed in the order, only on an EUR/USD rate **signed by the Nodary Airnode (API3)**, fresh, for exactly this request, and below Lena's limit. The Keeper can trigger the payment, never redirect it. | `api3/contracts/payonproof/InvoiceEscrow.sol` (EVM) |
| Will the Keeper get paid for work it did not do? | Lena's agent locks the Keeper's fee in **Masumi escrow on Cardano** before the Keeper starts. The Keeper collects only after it puts a **result hash** into the escrow that binds the fee to the `execute` transaction and its `InvoicePaid` event; if the condition never holds it authorizes a refund, and if it vanishes Lena takes the fee back after the deadline. | `keeper.ts`, `proof.ts`, `@agentic/core/escrow` |
| Which Keeper should she trust with the job? | Her agent asks every Keeper for a price and checks its **track record on chain**: receipts on Cardano, each verified against Base Sepolia. Code picks the cheapest acceptable Keeper within Lena's fee limit and explains every choice; her agent then signs only that Keeper's quoted fee. | `lena.ts`, `records.ts`, `@agentic/core/market` |

**AI interprets, deterministic checks gate money.** Claude (Haiku) turns Lena's sentence into a structured order; plain code validates every field and takes the supplier's address from Lena's own address book. Whether money moves is decided by the contracts (signed rate vs. limit; Masumi's escrow rules) and by code (the Keeper choice, and signing only the chosen offer).

### Seller, Buyer, Coworker

| | In PayOnProof |
|---|---|
| **Seller** (x402) | Three Keepers sell the same job over x402 on Cardano preprod at different prices (Atlas 2 tUSDM, Swift 1 tUSDM, Prime 4 tUSDM): "watch this order and execute it", paid into Masumi escrow; or per attempt in tADA, charged only on success (`--x402`). |
| **Buyer** | Lena's finance agent asks each Keeper for its x402 quote, checks its proof of which EVM account it executes from and its on-chain record, and decides in code: within Lena's 3 tUSDM fee limit, no false receipts, at least 2 verified executions for invoices above €250 (new Keepers start with small ones), cheapest wins. Every reason goes to the dashboard. |
| **Coworker** (Masumi) | The fee is locked before the work and released after delivery. Two agents on two chains: the Keeper's execution on Base Sepolia is what releases its pay on Cardano, through the result hash. |

## How one job works (escrow mode, the default)

```
Lena's finance agent                                     Keeper (chosen by code)                       chains
 "Pay INV-18, €400, when EUR/USD < 1.13"
 Claude → order; code checks it ──────────────────────────────────────────────────▶ InvoiceEscrow.createOrder   [Base Sepolia]
 asks 3 Keepers for a price, reads their records ──▶ quotes (x402 402)
 signs only the chosen offer: that Keeper, ≤ 3 tUSDM
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
| `LENA` | Lena's finance agent | Cardano (locks Keeper fees in Masumi escrow); EVM treasury = `api3/.env` `PRIVATE_KEY` (locks invoices in the InvoiceEscrow) |
| `KEEPER` | Keeper Atlas, 2 tUSDM per job | Cardano (earns fees, pays escrow and receipt transactions); EVM `KEEPER_EVM_PRIVATE_KEY` (gas for `execute`) |
| `KEEPER_B` | Keeper Swift, 1 tUSDM per job | same, `KEEPER_B_EVM_PRIVATE_KEY` |
| `KEEPER_C` | Keeper Prime, 4 tUSDM per job | same, `KEEPER_C_EVM_PRIVATE_KEY` |
| — | Café Verde, Fazenda Alta | suppliers' EVM addresses in Lena's address book (`lena.ts`) |

Ports: Keepers 4110, 4112, 4113; local anvil fallback 4118.

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

Per-attempt mode, kept as an option: `npm run demo -w apps/payonproof -- --x402` hires Keeper Atlas per attempt with a signed 2 tADA fee; a check whose condition is not met answers 409 and the fee is never submitted.

**Autopilot** (several invoices and cycles, no human in the loop): `npm run autopilot -w apps/payonproof -- --rounds 3 --every 4 --watch 3`. Every round two new invoices arrive; Lena's agent picks a Keeper for each and locks its fee; the Keepers loop on their own (signed rate → compare → execute when the limit holds). Each execution adds a receipt that the next round's choice reads, so a new Keeper that delivers small invoices earns the record it needs for larger ones.

**EVM network.** The escrow is deployed on **Base Sepolia** (addresses in `deployments.json`); the demo, autopilot and tamper test use it by default. `--evm anvil` (or `EVM_NETWORK=anvil`) starts a local anvil chain on port 4118, deploys the same contracts and runs against them. Cardano is always real preprod. To deploy afresh: `npm run deploy -w apps/payonproof -- --dry-run`, then without `--dry-run`.

## 60-second demo script

Before: dashboard open at http://127.0.0.1:4000 (press Clear first), a terminal in `cardano/`, the INV-18 collect transaction from an earlier run open in a browser tab (collecting needs 32 minutes, so it is shown, not waited for). Start `npm run demo -w apps/payonproof` about a minute before you begin: the locks need Cardano confirmations.

| Time | Say | Show / do |
|---|---|---|
| 0:00 | "Lena runs a coffee roastery in Munich. She owes her supplier €400 and wants to pay when EUR/USD is below 1.13, without watching charts. Her finance agent writes the order and locks the money in an escrow contract that can only ever pay that supplier." | Timeline: "Claude read it as INV-18 …"; blue arrow Lena → Invoice escrow (basescan link). |
| 0:12 | "Now it hires a Keeper. Three offer the job. Prime is over Lena's fee limit. Swift was brand new this afternoon, so it only got small invoices; its receipts on Cardano now match real payments on Base Sepolia, so it's the cheapest proven Keeper. Code picks Swift." | The three ✓/✗ lines with their reasons. |
| 0:25 | "Lena's agent locks Swift's fee in Masumi escrow on Cardano. Swift can see the money is there, Lena can't take it back while Swift works." | 🔒 edge Lena → Masumi escrow; cardanoscan link of the lock. |
| 0:35 | "Swift checks the API3-signed rate: below 1.13. Before moving money it buys a second signed rate from another AirnodeHub source for one cent over x402: they agree. It hands Nodary's signed rate to the contract, which checks signer, freshness and limit itself and pays the supplier." | "second source agrees"; Invoice escrow → Fazenda Alta; "INV-18 paid …" (basescan). |
| 0:45 | "Then Swift puts a hash into the escrow that binds its fee to that exact payment, and publishes a receipt. 32 minutes later, after Lena's dispute window, it collects." | "Result hash … into the Masumi escrow"; open the earlier collect transaction. |
| 0:55 | "INV-17's limit was never reached, so its Keeper gave the fee back. Pay on proof: the agent can't fake the data, can't take the money, and only earns when it delivered." | "Refund authorized … Lena took its 2 tUSDM back". |

For API3 judges: `npm run tamper -w apps/payonproof` opens an order, shows the four tampered responses (edited value, too old, another request, another signer) rejected by the contract, then one valid, fresh response executing it. Bring your own response with `-- --file response.json` (`pnpm --silent fetch-response EUR/USD > response.json` in `api3/`).

## Evidence

**Base Sepolia** (chain 84532): InvoiceEscrow [`0x63e2b722725eda487a9d76962ef4633dcc5e571a`](https://sepolia.basescan.org/address/0x63e2b722725eda487a9d76962ef4633dcc5e571a) (deploy tx [`0x37a2b603…`](https://sepolia.basescan.org/tx/0x37a2b6030c8991943cbddfc291d106b97d5ec4682e04d94a896c9c8f050c37c4)), request hash `0x5ccc3aa9…d3d0` (Nodary EUR/USD), `maxRateAge` 3 days; DemoUSD (dUSD, 6 decimals) [`0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf`](https://sepolia.basescan.org/address/0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf).

**Escrow jobs, 2026-10-30** (Keeper fees in Masumi escrow on Cardano preprod, invoices on Base Sepolia; every job closed). In time order: the first demo at 17:03 (Keeper Atlas chosen; Swift had no record yet, Prime over the cap), the autopilot from 17:08 (INV-101 to INV-106: Swift starts with small invoices, earns two verified executions and then wins the large ones), the demo at 17:30 with the second signed rate from AirnodeHub (Swift chosen), and the `--vanish` demo at 17:38 (the Keeper takes the lock and disappears; Lena refunds after the deadline). `npm run escrow -w apps/payonproof -- report` prints this table.

| Invoice | Keeper | Outcome | Fee lock | Execute (Base Sepolia) | Result hash in escrow | Receipt | Collect / refund |
|---|---|---|---|---|---|---|---|
| INV-17 | Keeper Atlas (2 tUSDM) | limit not reached | [`2e501ed9…`](https://preprod.cardanoscan.io/transaction/2e501ed977dd98727113199a91b547eaa405b9df840d02301b3f5d7b9a77a549) |  |  |  | authorize [`3778343d…`](https://preprod.cardanoscan.io/transaction/3778343d6685fe19662d82a94c59454ee8f6c6b0d10dcc308e9f1bee10937bf0), refund [`2e0105a5…`](https://preprod.cardanoscan.io/transaction/2e0105a5d83aac9b3ac7509ecdbf933191f7d1e3d1b3e22277862999bfd654b1) |
| INV-18 | Keeper Atlas (2 tUSDM) | executed | [`adcbd6fc…`](https://preprod.cardanoscan.io/transaction/adcbd6fc3d078d233e1ff462ac90695dd3a394a5c065f77fb8bf22cfd2cad652) | [`0xe66ff958…`](https://sepolia.basescan.org/tx/0xe66ff9582763a1a74b0bdb8865ce6a319e28ad92e194faeb7c2c7e75be08d38c) | [`8d18c05e…`](https://preprod.cardanoscan.io/transaction/8d18c05eca703f424efb687c90a6df182fb1ba6a040b87afbfe72eb6900ec0e2) | [`5e5a0eff…`](https://preprod.cardanoscan.io/transaction/5e5a0eff49ab64355fa06eb79e6b0000c82a7a3279de44143a592eb87229bba3) | collect [`27572169…`](https://preprod.cardanoscan.io/transaction/275721698939e368cc9bc4ab9be8e295ea351d553c541e17a1fc0d8cbafedb39) |
| INV-101 | Keeper Swift (1 tUSDM) | executed | [`430cf823…`](https://preprod.cardanoscan.io/transaction/430cf82303a6b5dfeafcde54630b8ab62fa8c90f2e8a936e659999a7955a69ed) | [`0xa7cd0c32…`](https://sepolia.basescan.org/tx/0xa7cd0c32f4906aac85958a63b710aca694c46687bec3b8d3b9d18e7dec494d8c) | [`9b5a743e…`](https://preprod.cardanoscan.io/transaction/9b5a743e97cfc8b44c9c90c1f403b76b25dfec98a838b3fe5d04e4ef8d69ca8e) | [`7e0d4a99…`](https://preprod.cardanoscan.io/transaction/7e0d4a990f6690da7f6ad221eedd399f9245e0bd4e06cae0cbc94e5276c1a9e6) | collect [`6e7eb6b7…`](https://preprod.cardanoscan.io/transaction/6e7eb6b71257abd40d81eb3d6835b99cdf11a415c09b4848e3591e1eb6e0e118) |
| INV-102 | Keeper Atlas (2 tUSDM) | executed | [`ba08d046…`](https://preprod.cardanoscan.io/transaction/ba08d0461b498ca87dbae1649b4cb5d740456d1a71e1b317a5a8a154aac2e069) | [`0x387715e2…`](https://sepolia.basescan.org/tx/0x387715e2d3a96be01bd998183111d02d1fcac471255269e42f0b94c8b9b5c873) | [`9a33f071…`](https://preprod.cardanoscan.io/transaction/9a33f07162684086a1b9c51329e794f694d971a7ca46303b115e5277d870b4d5) | [`8d2af721…`](https://preprod.cardanoscan.io/transaction/8d2af72113d4d8e225e28afdb787cec3ee4cab061b3c471e38077f0515bc7db7) | collect [`2ab6100c…`](https://preprod.cardanoscan.io/transaction/2ab6100c0eb050f63b013273dc2e4df01374222bc14bb26ab544bd6c5d5cc41a) |
| INV-103 | Keeper Swift (1 tUSDM) | executed | [`71bed142…`](https://preprod.cardanoscan.io/transaction/71bed14261c051f97bb9bac26f7f153e8e67b7a354c986eda1ac3c37aae445bc) | [`0x4d26f10c…`](https://sepolia.basescan.org/tx/0x4d26f10c37aa06ff718f2d2e8342734867e374dd71c878aa9ea9d218ceb17353) | [`ae74b3ac…`](https://preprod.cardanoscan.io/transaction/ae74b3acc890459c9629b1a29d96bb2f813d071785b1eb86fbd99ee6e4e5536d) | [`10509832…`](https://preprod.cardanoscan.io/transaction/1050983206b774b6d421de82184533a852d779baa3f86cda675c481b967a53f0) | collect [`b65010e0…`](https://preprod.cardanoscan.io/transaction/b65010e04a9b8d13979cf2158c132ab9413e4255cf9efcea1ce5509c7d533b97) |
| INV-104 | Keeper Atlas (2 tUSDM) | limit not reached (refund after the deadline) | [`1ae67141…`](https://preprod.cardanoscan.io/transaction/1ae67141372805e565b8ea0e452838276cc595ebc38281fefda67b1fe88b54ba) |  |  |  | refund [`7ce381cd…`](https://preprod.cardanoscan.io/transaction/7ce381cd41a61db93ccab9e1be20dbb5952fc165b79fd72db4eb3bc8f3f0a141) |
| INV-105 | Keeper Swift (1 tUSDM) | executed | [`06b80a0f…`](https://preprod.cardanoscan.io/transaction/06b80a0fa3af96a818a0f92100709e60a4a15a0fa9a1998e4b30df26cb293b3c) | [`0x1775924f…`](https://sepolia.basescan.org/tx/0x1775924f42bcc8f13aff3d6e36d891af20b99527554762b293b8b4dfc8dc21af) | [`243e5eb0…`](https://preprod.cardanoscan.io/transaction/243e5eb0ed77b7693b2252c750256a545fc9e988675ac60709edaac312877564) | [`184ccaec…`](https://preprod.cardanoscan.io/transaction/184ccaec89da046bccbd4cf0d651bd7495fe7f0522995ff856e47d4deadfe84c) | collect [`9a5785ec…`](https://preprod.cardanoscan.io/transaction/9a5785ec891622e536a22d231046cb7f5ba06a50f0df097797bab1cf1a6d5ccc) |
| INV-106 | Keeper Swift (1 tUSDM) | executed | [`0486ede1…`](https://preprod.cardanoscan.io/transaction/0486ede1ee89d3a589559f85b9466fee011c940ae36db067537b377b69415127) | [`0xf45836b5…`](https://sepolia.basescan.org/tx/0xf45836b5bf327cd2fe533106b37206a7aeda63aa15e295bb04929a4a495bd8ac) | [`305d3ebc…`](https://preprod.cardanoscan.io/transaction/305d3ebce72b96f0f125660e9ade83d5983a28dbc0d33cf74a29574f08516c51) | [`f09d13c2…`](https://preprod.cardanoscan.io/transaction/f09d13c25e5caf230eb9036bc1f809c72e643584a9cabc01f0df3a1abd5ca0ff) | collect [`c645d7e5…`](https://preprod.cardanoscan.io/transaction/c645d7e5af934d76ef6a9fe33d7d0305b860e8e3c3f902466c4faad578252424) |
| INV-17 | Keeper Swift (1 tUSDM) | limit not reached | [`d6e0994b…`](https://preprod.cardanoscan.io/transaction/d6e0994b5af56427592904e465e810872f2b3e249f60f993113a8bd961c3856f) |  |  |  | authorize [`5b4201d9…`](https://preprod.cardanoscan.io/transaction/5b4201d9fa1aae3a3959ae47fac73292074e7d230105814ac99d6a35119d7a34), refund [`b883ed3a…`](https://preprod.cardanoscan.io/transaction/b883ed3abd0ab541d588f9b1f9b2fd500d94da6b17c6b144b4fb266b815448b1) |
| INV-18 | Keeper Swift (1 tUSDM) | executed | [`b3344486…`](https://preprod.cardanoscan.io/transaction/b334448662936c03e3b20f49037f367fd2482d637229d5986e86c5ec53067035) | [`0x33d78b68…`](https://sepolia.basescan.org/tx/0x33d78b680c8e4013de0ce4cd3f2e4cd32f12795fb50b1516f13133a2ed5d67c7) | [`c2a93b36…`](https://preprod.cardanoscan.io/transaction/c2a93b36301bf22d0990ea8ad57cad016d35308a09d99959e4f91bbca2aa1686) | [`34a02939…`](https://preprod.cardanoscan.io/transaction/34a029397ae4a5885905ed669d739f543b0dbf349b41307e8d49aaf70871bd58) | collect [`c6f50fe6…`](https://preprod.cardanoscan.io/transaction/c6f50fe603b3aa6940f710bb537387dc240dd2331ff181efea84033da0939e58) |
| INV-17 | Keeper Swift (1 tUSDM) | Keeper vanished | [`41f3659c…`](https://preprod.cardanoscan.io/transaction/41f3659cdedab12ff2ecddc28df97920fb8068808c4fe1f80bd4cf4cf2c4b008) |  |  |  | refund [`b903d2c3…`](https://preprod.cardanoscan.io/transaction/b903d2c30068d2ae1d897e7ab2e3ab5e05241030d0077ef42d81631713bba2ed) |
| INV-18 | Keeper Swift (1 tUSDM) | Keeper vanished | [`b8487f50…`](https://preprod.cardanoscan.io/transaction/b8487f505ef5974e2efc62388b9d98d74ba2c67fa113e027998117520dc3dd59) |  |  |  | refund [`c4d99a58…`](https://preprod.cardanoscan.io/transaction/c4d99a588c17fba616b9a24b5f184318972a48c04519a962cb75f20ef9919145) |

Notes: INV-104's refund authorization failed on a fragmented Keeper wallet (no UTxO fit for collateral), so Lena took the fee back after the deadline; core now pays itself a collateral UTxO and retries. Second signed rate bought over x402 before INV-18 at 17:30: 0.01 aUSD [`0xf4e9adf9…`](https://sepolia.basescan.org/tx/0xf4e9adf9482e3ea98385e5704ff3fe365e92e5d63e7bf8a5c715c104a0114b06) (Frankfurter 1.1181 vs Nodary 1.11652, 0.14 % apart). `npm run check -w apps/payonproof -- 5e5a0eff49ab64355fa06eb79e6b0000c82a7a3279de44143a592eb87229bba3` verifies a receipt on both chains.

**Per-attempt x402 run, 2026-10-30 16:55** (fee settles only after the escrow paid): INV-18 executed [`0x69c789f0…`](https://sepolia.basescan.org/tx/0x69c789f0e3065fdf554912503ca0c45089f17feaf93ab92f692b7fb548d3a982), fee 2 tADA [`22639574…`](https://preprod.cardanoscan.io/transaction/226395746c8076b5e5fd3279cfd6287d525ef2440582459bd8e9283e83e69c7f), receipt [`9dbd3060…`](https://preprod.cardanoscan.io/transaction/9dbd306022e5e379de1fcb85a516bc97d6965f9980fbfa80e780365e948795ad). Attempts whose condition was not met: HTTP 409, no transaction exists (`cardano/.audit/payonproof-lena.jsonl`, decision `voided`). Earlier runs: fee [`4a5300fe…`](https://preprod.cardanoscan.io/transaction/4a5300fe0927359c8c1ab84e32befb86e3b14296c4be7e2139cd3c5b754d1534) with receipt [`d578fe53…`](https://preprod.cardanoscan.io/transaction/d578fe53cd06c3c1d50acba2ee244ee61cc378c5527ec9cf4efd6d0d45dfc7df), fee [`d5477e11…`](https://preprod.cardanoscan.io/transaction/d5477e116ecff63a33cf6b340feebc9c869604c03d0748576db70b431191a3d5) with receipt [`3c9017a0…`](https://preprod.cardanoscan.io/transaction/3c9017a0ee8b8c68e62dd3c197bfb0ad8e670e7b90f0fb141de1332dfd850fde).

**Tamper test, 2026-10-30 17:00**: edited value, too old, another request (BTC/USD) and another signer rejected by the contract (`NotSignedByAirnode`, `ResponseTooOld`); the valid response executed [`0xc023058f…`](https://sepolia.basescan.org/tx/0xc023058f9b1ba13da7325bc9c6a1ae3013ce756f124639eb4d2827a295e164fb).

**Escrow run after AgentGuard was removed, 2026-10-31 03:01 CET** (Lena signs only the chosen offer): INV-18, Keeper Swift (1 tUSDM): fee lock [`75e46582…`](https://preprod.cardanoscan.io/transaction/75e465822791e14cb240c446cb3a7666268ecac18dc3135520db73f39d097eb5), second rate over x402 [`0x044561b5…`](https://sepolia.basescan.org/tx/0x044561b504a2021f144fb6006c980882751a997dd29da0c8bacffdf6fd8ed422), execute [`0x1758f8f7…`](https://sepolia.basescan.org/tx/0x1758f8f7bc1be272ba4e913afd3035c3eb3904f8dfb20248694d718cf8f4b06e) (446.53 dUSD), result hash [`5e979434…`](https://preprod.cardanoscan.io/transaction/5e979434207d9e9bf134739c94e0afeb4bbbae6f81a19903cd74f314db5acc5e), receipt [`e02045b8…`](https://preprod.cardanoscan.io/transaction/e02045b8777435086b22fdd615b8379688d94d01dbe073d591b1c814a4bf304f), collect [`1e45c3d4…`](https://preprod.cardanoscan.io/transaction/1e45c3d4147332336b12d658e0f413b92417963b126513e98fb583093fc2b940). INV-17, Keeper Swift: lock [`a8b66f01…`](https://preprod.cardanoscan.io/transaction/a8b66f0175d5740406fb7c3c0d4a07af5a81e8e6e27a28cde72d3de57701c65d), limit not reached, authorize [`e422fbe5…`](https://preprod.cardanoscan.io/transaction/e422fbe5ecfacb8b877be98dbb3cacecfe8dfa7c4708ed88fb89e720a0fb8d86), Lena's refund [`3a07af8a…`](https://preprod.cardanoscan.io/transaction/3a07af8a94e7fbe731cddb05fc5d808143033f28c429161b92be67366538fa9a).

**Tamper test, 2026-10-31 03:10 CET**: order 35 [`0xb9acbcd8…`](https://sepolia.basescan.org/tx/0xb9acbcd87d3b27e8433674ebe1a1b951a85df5f5d29a872e3ddf0c1700aed60b); the four tampered responses rejected (`NotSignedByAirnode`, `ResponseTooOld`, `NotSignedByAirnode` for BTC/USD, `NotSignedByAirnode` for another key); the valid response executed [`0x27fe4dd7…`](https://sepolia.basescan.org/tx/0x27fe4dd7dd2eace19294931b8f5b0792ecf70d06a6eb80cd64da13f57e50a634).

## Weekend FX

Nodary's EUR/USD may stop updating once FX markets close on Friday evening. The escrow accepts a rate up to 3 days old, while the signed response itself must be at most 5 minutes old.

**Check after the close, Friday 2026-10-30, 23:16–23:31 CET** (`npm run rate`, then the escrow demo, then the tamper test, then `npm run rate` again):

- **Rate:** Nodary EUR/USD 1.11633, taken 21:02:44 UTC and unchanged at 23:31 CET (89 minutes old); the signed response is fresh on every request, so `InvoiceEscrow` accepts it. Frankfurter (ECB reference rates) also stays at Friday's value (1.1172), so the second-source check still passes (0.08 % apart).
- **Escrow demo:** Lena's agent chose Keeper Swift (1 tUSDM). INV-18 executed at 1.11633 (order 31, 446.53 dUSD to Fazenda Alta): fee lock [`f2a34adb…`](https://preprod.cardanoscan.io/transaction/f2a34adb9a3f4b70ebd4e5883536a642afcf6003ac3012a8f2c2655ef2b446f6), execute [`0xeb3fd14a…`](https://sepolia.basescan.org/tx/0xeb3fd14abf0f027a9fa43a730e112b41e970dafe217392f96a120782c11c2a3d), result hash [`1dfc78cb…`](https://preprod.cardanoscan.io/transaction/1dfc78cbab0e441708ffe0a41e15dc96f1547b0f3749f2709396b6ff3f128cae), receipt [`6a571c31…`](https://preprod.cardanoscan.io/transaction/6a571c31114b62658e5af500193c69f223af75e1e950e039fa662844d250c54d), collect [`8f66879d…`](https://preprod.cardanoscan.io/transaction/8f66879d85442df66690f922d4a5a042655f1c7456f8725aaa2adf7491363bae) at 00:01 on Saturday. INV-17 (limit 1.11, just below the live rate) not reached: lock [`b7abeabf…`](https://preprod.cardanoscan.io/transaction/b7abeabfbbf242e9d1220d748876bb373992002eb0e89c6943bac1cc838ecaff), authorize [`aa6fb1f8…`](https://preprod.cardanoscan.io/transaction/aa6fb1f8085676a29d1a941bf4fd085b3edb5510f630d57933d951a84c64ebc4), refund [`55c10d33…`](https://preprod.cardanoscan.io/transaction/55c10d33004eabe5aa216d19630b83be1c578aee64734f8915ff3fa5e2329b25).
- **Tamper test:** order 32; the four tampered responses were rejected (`NotSignedByAirnode`, `ResponseTooOld`), the valid one executed [`0xb358dca1…`](https://sepolia.basescan.org/tx/0xb358dca1c0897b212333468cceb9a3b528d8da896e38b03a91adec185c9509e8).

Result: after the close PayOnProof keeps working, at Friday's last rate. A rate taken at 21:02 UTC on Friday stays acceptable until Monday 21:02 UTC, after FX reopens on Sunday evening. Over the weekend an order executes at a price the market no longer quotes; that is the payer's risk to accept or to avoid by setting a deadline after Monday's open.

## Limits

See [docs/LIMITATIONS.md](../../../docs/LIMITATIONS.md) ([中文](../../../docs/LIMITATIONS.zh.md)): the per-attempt fee is held by the Keeper and could be double-spent (fixed by escrow, now the default); escrow waits 32 minutes before the Keeper collects and does not itself check the result hash; Keeper records count only deliveries; weekend FX; Nodary is still trusted for the value.
