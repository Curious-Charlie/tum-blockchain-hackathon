# Devfolio submission draft

Draft texts for the Devfolio form. Nothing here is submitted automatically.

- **Project name:** PayOnProof
- **Tagline:** Agents that pay invoices on API3-signed FX rates, and get paid only on proof.
- **Tracks:** Cardano (Agentic Commerce on Cardano), API3 (Any API in your contract)
- **Repository:** https://github.com/Curious-Charlie/tum-blockchain-hackathon (public at submission)
- **Demo video:** TBD (must include the API3 tamper test)

## The problem it solves

A small importer pays foreign suppliers in euros but holds dollars. She wants to pay when the rate is right, without watching charts, and without handing an agent a wallet it could empty. Today that means a bank's limit order (slow, expensive, not for small invoices) or trusting software blindly: an agent could fake the rate, pay the wrong account, or charge for checks it never ran.

PayOnProof makes each of those impossible or visible:

- The invoice money sits in a contract that pays **only the supplier fixed in the order**, **only on an EUR/USD rate signed by the Nodary Airnode (API3)**, fresh, for exactly that request, and below her limit.
- The agent that executes the payment (the Keeper) is **paid only on proof**: its fee is locked in Masumi escrow on Cardano and released after it puts a hash of the payment it made into the escrow; if the limit is never reached it gives the fee back.
- Her own agent **chooses which Keeper to pay** from on-chain records and stays inside AgentGuard's budget.

## How it works

1. Lena writes one sentence: "Pay Fazenda Alta invoice INV-18, €400, when EUR/USD is under 1.13". Claude (Haiku) turns it into an order; code validates every field and takes the supplier's address from her address book, never from the model.
2. Her agent locks the dollars in `InvoiceEscrow` on Base Sepolia.
3. It asks three Keepers for a price (their x402 quotes on Cardano preprod), checks each Keeper's proof of which EVM account it executes from and its record (CIP-20 receipts on Cardano, each verified against an `InvoicePaid` event on Base Sepolia), and picks the cheapest acceptable one within AgentGuard's caps. New Keepers start with invoices up to €250. Every reason is shown on the dashboard.
4. It locks the Keeper's fee in Masumi escrow (x402 with `assetTransferMethod: "masumi"`). The Keeper checks the lock against the terms it signed.
5. The Keeper loops: fetch a Nodary-signed EUR/USD rate, compare it with the limit, and when it holds call `InvoiceEscrow.execute` with the signed response. The contract verifies signer, request hash, response age (≤ 5 min), rate age (≤ 3 days) and the limit, then pays the supplier `€ × rate` and refunds the rest.
6. The Keeper puts `sha256(execution proof)` into the escrow (SubmitResult), publishes a CIP-20 receipt and collects after Lena's dispute window. If the limit never holds in its watch window it authorizes a refund; if it vanishes, Lena withdraws after the deadline.
7. Anyone can check a receipt against both chains: `npm run check -w apps/payonproof -- <receipt tx>`.

**Principle: AI interprets, deterministic checks gate money.** The LLM never decides whether money moves.

## Cardano

- **Tools:** x402 on preprod (`@x402/cardano`, `@x402/express`, `@x402/fetch`) with an in-process facilitator; Masumi escrow (`vested_pay` payment V2): lock via x402, then SubmitResult, Withdraw, AuthorizeRefund, WithdrawRefund built with evolution-sdk; tUSDM and tADA; CIP-20 transaction metadata for receipts; Blockfrost.
- **Seller / Buyer / Coworker:** Keepers sell execution jobs over x402; Lena's agent buys within AgentGuard limits after comparing prices and on-chain records; the fee is settled through Masumi escrow only after delivery, with refunds for no delivery.
- **In the real world:** an SME's finance agent (or an accounting tool) posts invoices; independent Keepers compete on price and record; fees are per executed invoice, nothing for watching. Lena's dollars could be any stablecoin; the payment contract runs on any EVM chain where the supplier is paid.
- **Business model:** the Keeper charges a fee per executed invoice (here 1–4 tUSDM); a platform can take a share of Keeper fees or charge for the finance agent.
- **Paid transactions on preprod:** see the [README](../README.md#for-cardano-judges) and the [app README](../cardano/apps/payonproof/README.md#evidence). Fee lock [`adcbd6fc…`](https://preprod.cardanoscan.io/transaction/adcbd6fc3d078d233e1ff462ac90695dd3a394a5c065f77fb8bf22cfd2cad652), result hash [`8d18c05e…`](https://preprod.cardanoscan.io/transaction/8d18c05eca703f424efb687c90a6df182fb1ba6a040b87afbfe72eb6900ec0e2), receipt [`5e5a0eff…`](https://preprod.cardanoscan.io/transaction/5e5a0eff49ab64355fa06eb79e6b0000c82a7a3279de44143a592eb87229bba3), collect after the unlock time [`27572169…`](https://preprod.cardanoscan.io/transaction/275721698939e368cc9bc4ab9be8e295ea351d553c541e17a1fc0d8cbafedb39), refund [`2e0105a5…`](https://preprod.cardanoscan.io/transaction/2e0105a5d83aac9b3ac7509ecdbf933191f7d1e3d1b3e22277862999bfd654b1), per-attempt x402 fee [`22639574…`](https://preprod.cardanoscan.io/transaction/226395746c8076b5e5fd3279cfd6287d525ef2440582459bd8e9283e83e69c7f).

## API3

- **Network:** Base Sepolia (84532). **Contract:** InvoiceEscrow `0x63e2b722725eda487a9d76962ef4633dcc5e571a`; DemoUSD `0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf`.
- **Signed data:** Nodary Airnode v2 (`0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0`), `latestFeeds` EUR/USD with the projection `{price, updatedAt}`; request hash `0x5ccc3aa98c84e0929a84c28f3fe16c2a89b2e58965b487b5580af40be401d3d0`.
- **Checks in the contract:** expected signer, expected request hash, response signed ≤ 5 minutes ago, rate taken ≤ 3 days ago, rate below the order's limit, order open and before its deadline; an order pays once.
- **What the value drives:** whether the invoice is paid and how much the supplier gets (`€ × signed rate`); the rest returns to the payer.
- **Tamper test:** `npm run tamper -w apps/payonproof`: one valid, fresh response executes; four are rejected (value edited, too old, another request, another signer). **Judges' own response:** `npm run tamper -w apps/payonproof -- --file <response.json>` (from `cardano/`; make one with `pnpm --silent fetch-response EUR/USD` in `api3/`).
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

- Count refunds and no-shows in a Keeper's record, and let Lena dispute a false result hash through Masumi.
- Move the second-source check (now done by the Keeper) into the contract: require two Airnodes to agree before paying.
- Real stablecoins on mainnet, more currency pairs, and conditions beyond FX (delivery events, flight delays).

## Honest limitations

[docs/LIMITATIONS.md](LIMITATIONS.md) ([中文](LIMITATIONS.zh.md)).
