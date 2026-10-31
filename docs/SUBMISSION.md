# Devfolio submission draft

Texts for the Devfolio form, one section per field. Nothing here is submitted automatically.

- **Project name:** PayOnProof
- **Tagline:** Agents that pay invoices on API3-signed FX rates, and get paid only on proof.
- **Tracks:** Cardano (Agentic Commerce on Cardano), API3 (Any API in your contract)
- **Repository:** https://github.com/Curious-Charlie/tum-blockchain-hackathon (public at submission)
- **Demo video:** https://youtu.be/v7hk3LD6cW8 (YouTube, unlisted, 1:45; a designed film with a techno soundtrack synthesized in code; every transaction shown is real: a paid Masumi escrow job and the API3 tamper test)
- **Technologies:** Cardano, Masumi, x402, Blockfrost, evolution-sdk, CIP-20, API3 AirnodeHub, Nodary, Base Sepolia, Solidity, Foundry, viem, TypeScript, Node.js, Claude
- **Pictures** (stills of the film, in this order): cover, who it is for, the buyer agent choosing a Keeper, the fee going into Masumi escrow, the signed rate checked on chain and the supplier paid, the API3 tamper test, business model, "Verify it."

Before submitting: the repository is public, both tracks are selected.

## The problem it solves

A small importer pays foreign suppliers in euros but holds dollars. She wants to pay when the rate is right, without watching charts, and without handing an agent a wallet it could empty. Today that means a bank's limit order (slow, expensive, not for small invoices) or trusting software blindly: an agent could fake the rate, pay the wrong account, or charge for checks it never ran.

PayOnProof makes each of those impossible or visible:

- The invoice money sits in a contract that pays **only the supplier fixed in the order**, **only on an EUR/USD rate signed by the Nodary Airnode (API3)**, fresh, for exactly that request, and below her limit.
- The agent that executes the payment (the Keeper) is **paid only on proof**: its fee is locked in Masumi escrow on Cardano and released after it puts a hash of the payment it made into the escrow; if the limit is never reached it gives the fee back.
- Her own agent **chooses which Keeper to pay** from on-chain records and signs only the offer it chose.

## How it works

1. Lena's team posts one sentence as a Task to its finance agent, a Sokosumi Coworker: "Pay Fazenda Alta invoice INV-20, €400, as soon as EUR/USD is under 1.13". Claude (Haiku) turns it into an order; code validates every field and takes the supplier's address from her address book, never from the model.
2. Her agent locks the dollars in `InvoiceEscrow` on Base Sepolia.
3. It asks three Keepers for a price (their x402 quotes on Cardano preprod), checks each Keeper's proof of which EVM account it executes from and its record (CIP-20 receipts on Cardano, each verified against an `InvoicePaid` event on Base Sepolia), and picks the cheapest acceptable one within her fee limit (3 tUSDM). New Keepers start with invoices up to €250. Every reason is shown on the dashboard.
4. It locks the Keeper's fee in Masumi escrow (x402 with `assetTransferMethod: "masumi"`). The Keeper checks the lock against the terms it signed.
5. The Keeper loops: fetch a Nodary-signed EUR/USD rate, compare it with the limit, and when it holds call `InvoiceEscrow.execute` with the signed response. The contract verifies signer, request hash, response age (≤ 5 min), rate age (≤ 3 days) and the limit, then pays the supplier `€ × rate` and refunds the rest.
6. The Keeper puts `sha256(execution proof)` into the escrow (SubmitResult), publishes a CIP-20 receipt and collects after Lena's dispute window. Before that, Lena's agent rebuilds the proof from Base Sepolia and disputes the result in the escrow if it does not match. If the limit never holds in its watch window the Keeper authorizes a refund; if it vanishes, Lena withdraws after the deadline.
7. The Task on Sokosumi is completed with every step and transaction link; follow-up questions in the thread are answered from the job's facts.
8. Anyone can check a receipt against both chains: `npm run check -w apps/payonproof -- <receipt tx>`.

**Principle: AI interprets, deterministic checks gate money.** The LLM never decides whether money moves.

## Cardano

- **Tools:** x402 on preprod (`@x402/cardano`, `@x402/express`, `@x402/fetch`) with an in-process facilitator; Masumi escrow (`vested_pay` payment V2): lock via x402, then SubmitResult, Withdraw, AuthorizeRefund, WithdrawRefund built with evolution-sdk; tUSDM and tADA; CIP-20 transaction metadata for receipts; Blockfrost.
- **Seller / Buyer / Coworker:** Keepers sell execution jobs over x402; Lena's agent compares prices and on-chain records in code and signs only the chosen offer; the fee is settled through Masumi escrow only after delivery, with refunds for no delivery.
- **In the real world:** an SME's finance agent (or an accounting tool) posts invoices; independent Keepers compete on price and record; fees are per executed invoice, nothing for watching. Lena's dollars could be any stablecoin; the payment contract runs on any EVM chain where the supplier is paid.
- **Business model:** the Keeper charges a fee per executed invoice (here 1–4 tUSDM); a platform can take a share of Keeper fees or charge for the finance agent.
- **In the workshop's terms:** *Business operations*: agents that pay invoices and settle with suppliers. x402 + Masumi gives refunds and decision logging (the result hash); public registry and identity are not done yet (the Keepers are not registered with Masumi). No-shows and disputed results count against a Keeper, read from the escrow on chain. Before a fee unlocks, Lena's agent rechecks the result hash against Base Sepolia and disputes it in the escrow if it does not match (`--lie` demo: a Keeper claims a payment it never made; disputes [`4c465a94…`](https://preprod.cardanoscan.io/transaction/4c465a9475d06c601fdbba6eb98131eb9ed06af1a8a5d94897fe7e67db507c47), [`bdec4ff3…`](https://preprod.cardanoscan.io/transaction/bdec4ff3cd37ba06b2faa111c4dad93b5579b60338176862a3d555f9cdf4580c)).
- **On Sokosumi:** Lena's finance agent is a Coworker ("PayOnProof finance agent", `01a1900c-8cc4-75cf-8c54-30a0161eac48`) in the TUM-Hackathon Workspace. Task `01a19013-9dd6-746e-81c8-edda7b120763`: a team posted "Pay Fazenda Alta invoice INV-20, €400, as soon as EUR/USD is under 1.13"; the Coworker hired Keeper Swift, the invoice was paid on Base Sepolia, the Task completed with every transaction link, and a follow-up question was answered from the job's facts.
- **Why Cardano:** payments with rules (the fee waits in Masumi's escrow until delivery), native stablecoins (tUSDM), deterministic transactions (Lena's agent checks the exact payment before it signs), a non-custodial facilitator that only verifies and relays.
- **Paid task on preprod, end to end (Sat 31 Oct, 03:01–03:07 CET):** fee lock in Masumi escrow [`75e46582…`](https://preprod.cardanoscan.io/transaction/75e465822791e14cb240c446cb3a7666268ecac18dc3135520db73f39d097eb5), execution on Base Sepolia [`0x1758f8f7…`](https://sepolia.basescan.org/tx/0x1758f8f7bc1be272ba4e913afd3035c3eb3904f8dfb20248694d718cf8f4b06e), result hash [`5e979434…`](https://preprod.cardanoscan.io/transaction/5e979434207d9e9bf134739c94e0afeb4bbbae6f81a19903cd74f314db5acc5e), receipt [`e02045b8…`](https://preprod.cardanoscan.io/transaction/e02045b8777435086b22fdd615b8379688d94d01dbe073d591b1c814a4bf304f), collect [`1e45c3d4…`](https://preprod.cardanoscan.io/transaction/1e45c3d4147332336b12d658e0f413b92417963b126513e98fb583093fc2b940), refund for the invoice whose limit was never reached [`3a07af8a…`](https://preprod.cardanoscan.io/transaction/3a07af8a94e7fbe731cddb05fc5d808143033f28c429161b92be67366538fa9a). More runs: [README](../README.md#for-cardano-judges) and [app README](../cardano/apps/payonproof/README.md#evidence).

## API3

- **Network:** Base Sepolia (84532). **Contract:** InvoiceEscrow `0x63e2b722725eda487a9d76962ef4633dcc5e571a`; DemoUSD `0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf`.
- **Signed data:** Nodary Airnode v2 (`0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0`), `latestFeeds` EUR/USD with the projection `{price, updatedAt}`; request hash `0x5ccc3aa98c84e0929a84c28f3fe16c2a89b2e58965b487b5580af40be401d3d0`.
- **Checks in the contract:** expected signer, expected request hash, response signed ≤ 5 minutes ago, rate taken ≤ 3 days ago, rate below the order's limit, order open and before its deadline; an order pays once.
- **What the value drives:** whether the invoice is paid and how much the supplier gets (`€ × signed rate`); the rest returns to the payer.
- **Tamper test:** `npm run tamper -w apps/payonproof`: one valid, fresh response executes; four are rejected (value edited, too old, another request, another signer). Last run (Sat 31 Oct, 03:10 CET): valid response executed [`0x27fe4dd7…`](https://sepolia.basescan.org/tx/0x27fe4dd7dd2eace19294931b8f5b0792ecf70d06a6eb80cd64da13f57e50a634); the four were rejected with `NotSignedByAirnode`, `ResponseTooOld`, `NotSignedByAirnode`, `NotSignedByAirnode`. **Judges' own response:** `npm run tamper -w apps/payonproof -- --file <response.json>` (from `cardano/`; make one with `pnpm --silent fetch-response EUR/USD` in `api3/`).
- **Autonomous agent, several cycles:** `npm run autopilot -w apps/payonproof`: new invoices every round; each Keeper loops on signed rates and executes on its own (last run: 6 invoices, 3 rounds, 5 executed).
- **Pays over x402 for data when it matters:** before moving money a Keeper buys a second signed EUR/USD from Frankfurter on AirnodeHub (0.01 aUSD, x402 on Base Sepolia), verifies signer and request hash, and executes only if the two sources agree within 1 %.

### API3 questions

**Who relies on this data?**

- **The payer (Lena):** the signed EUR/USD rate decides when her money leaves the escrow and how many dollars an invoice costs her.
- **The supplier:** receives `€ amount × rate` in dollars, so the rate decides whether the euro invoice is paid in full.
- **The Keeper:** can execute, and so earn its fee, only with a valid signed rate below the limit.
- **The contract:** the signed rate is the only trigger. Neither the Keeper nor Lena's AI agent can release the money without it.

**What happens if the data is forged?**

- A forged **lower** rate would trigger a payment Lena refused (the real rate is above her limit) and **underpay the supplier**: fewer dollars than the euro invoice is worth, with the difference flowing back to the payer. A Keeper colluding with a payer could short-change every supplier this way.
- A forged **higher** rate below the limit would **overpay the supplier** out of Lena's deposit.
- A **stale** rate would execute at a price the market has left behind; a response for **another request** (another pair, a crypto price) would be read as EUR/USD and pay an absurd amount.
- The contract therefore checks the signer, binds the EUR/USD request hash, and limits the response age (5 minutes) and the rate age (3 days). The tamper test shows each forgery rejected.

**Data we wanted but did not find on AirnodeHub**

- **Shipment and delivery events** (carrier tracking, bills of lading), to pay "when the goods arrived and the rate is right", the usual condition in trade finance.
- **EU VAT number validation (VIES) and Latin American company registries**, so the payer's agent could check that a new supplier's payee is a registered business before the first payment. GLEIF and Companies House cover parts of this, not EU VAT or Colombia and Brazil.
- **An explicit FX market-status signal** (open, closed, holiday), so a contract can tell "the rate is old because the market is closed" from "the feed is broken". Today we accept a 3-day-old rate to get through weekends.

## Challenges

- Two chains, one job: the Keeper's pay on Cardano had to be tied to its payment on Base Sepolia without a bridge; we bind them with a result hash of the execution proof, checkable by anyone.
- Masumi's escrow deadlines (at least 15 minutes to the result, 15 more to unlock) shape the user experience: the Keeper collects 32 minutes after the quote.
- FX closes on weekends; the contract had to accept older rates while still requiring fresh signatures.
- Agents spending from one Cardano wallet collide on UTxOs; every role has its own wallet and spending is serialized per wallet.

## What's next

- Register the Keepers in Masumi's registry; paid Sokosumi Tasks through a Masumi Payment Service; settle disputes with Masumi's admins.
- Move the second-source check (now done by the Keeper) into the contract: require two Airnodes to agree before paying.
- Real stablecoins on mainnet, more currency pairs, and conditions beyond FX (delivery events, flight delays).

## Honest limitations

[docs/LIMITATIONS.md](LIMITATIONS.md) ([中文](LIMITATIONS.zh.md)).
