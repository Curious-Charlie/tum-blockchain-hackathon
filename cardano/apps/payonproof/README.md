# D1 PayOnProof: a Keeper agent that is paid only when it actually pays your invoice

> *Don't trust your agent. Verify it.*

Lena runs a small coffee roastery in Munich. Her Colombian supplier invoices her **€1,000**, but she holds US dollar stablecoins. She wants to pay **when EUR/USD drops below 1.11**, without watching the market. She tells her finance agent in one sentence; the agent hires a **Keeper agent** that watches the rate and executes the payment.

Two trust problems, two answers:

| Worry | Answer | Where |
|---|---|---|
| Will the Keeper fake the rate or steal the money? | The invoice money sits in an escrow contract. It pays only the supplier fixed in the order, only on an EUR/USD rate **signed by the Nodary Airnode (API3)**, fresh, for exactly this request, and below Lena's limit. The Keeper can trigger the payment, never redirect it. | `api3/contracts/payonproof/InvoiceEscrow.sol` (EVM) |
| Will the Keeper charge for checks that did nothing? | Every attempt carries a **signed x402 fee on Cardano preprod**. If the condition is not met the Keeper answers HTTP 409 and the signed transaction is **never submitted**: Lena pays nothing. Only a successful execution (HTTP 200 with the escrow transaction) settles the fee. | `keeper.ts`, `@agentic/core` Seller |

**AI interprets, deterministic checks gate money.** Claude (Haiku) turns Lena's sentence into a structured order; plain code validates every field and takes the supplier's address from Lena's own address book. Whether money moves is decided by the contract (signed rate vs. limit) and by the HTTP status the Keeper can only return after the contract paid.

## How one attempt works

```
Lena's finance agent ──(x402: signed 2 tADA, not yet on chain)──▶ Keeper agent   [Cardano preprod]
   AgentGuard: payee = Keeper only,                                 │ fetch Nodary-signed EUR/USD
   ≤ 2 tADA per payment and per invoice,                            │ verify signer + request off chain
   ≤ 30 tADA a day, kill switch                                     ▼
                                    rate ≥ limit ─▶ HTTP 409 ─▶ fee voided, nothing paid
                                    rate < limit ─▶ InvoiceEscrow.execute(order, signed response)   [EVM]
                                                      checks signer, request hash, response age ≤ 5 min,
                                                      rate age, rate < limit, order still open
                                                      pays €amount × signed rate to the supplier,
                                                      refunds the rest to Lena
                                                 ─▶ HTTP 200 + EVM tx ─▶ fee settles on Cardano
```

## Roles and wallets

| Role | Agent | Wallets |
|---|---|---|
| `LENA` | Lena's finance agent | Cardano (pays Keeper fees through AgentGuard); EVM treasury = `api3/.env` `PRIVATE_KEY` (locks invoices in the escrow) |
| `KEEPER` | Keeper agent | Cardano (earns fees); EVM `KEEPER_EVM_PRIVATE_KEY` in this app's `.env` (pays gas for `execute`, created on first run) |
| — | Café Verde, Fazenda Alta | suppliers' EVM addresses in Lena's address book (`lena.ts`) |

Ports: Keeper 4110, local anvil 4118.

## Setup and run

Needs Node 22+, Foundry (`forge`, `anvil`), `cardano/.env` (Blockfrost, Anthropic key) and this app's `.env` (`LENA_MNEMONIC`, `KEEPER_MNEMONIC`; `npm run wallets -w apps/payonproof` creates them). `api3/.env` holds the EVM key and `RPC_URL`.

```sh
cd cardano && npm install
cd ../api3 && git submodule update --init --recursive && forge test   # 12 escrow tests incl. the 4 tamper cases
cd ../cardano
npm run dashboard                                   # terminal 1: http://127.0.0.1:4000
npm run wallets -w apps/payonproof                  # LENA needs tADA (Masumi dispenser); KEEPER starts empty
npm run demo -w apps/payonproof                     # terminal 2: the whole flow, ~1 minute
npm run tamper -w apps/payonproof                   # API3 tamper test: 1 valid + 4 rejected responses
```

Demo options: `--limit-a 1.11 --limit-b 1.13` set the two invoices' EUR/USD limits (defaults: just below and just above the live rate, so both paths show), `--rounds 2`, `--interval 12` (seconds between polling rounds), `--evm base-sepolia|anvil`.

**EVM network.** The demo uses Base Sepolia when `deployments.json` lists an escrow there, otherwise it starts a local anvil chain, deploys the same contracts and runs against them (Cardano is always real preprod). To deploy on Base Sepolia:

```sh
npm run deploy -w apps/payonproof -- --dry-run      # prints the cost; the L1 data fee dominates
npm run deploy -w apps/payonproof                   # deploys InvoiceEscrow, funds the Keeper's EVM account
```

## 60-second demo script

Before: dashboard open at http://127.0.0.1:4000 (click Reset), terminal ready in `cardano/`.

| Time | Say | Show / do |
|---|---|---|
| 0:00 | "Lena owes her coffee supplier €1,000 but holds dollars. She wants to pay when the euro is cheap, below 1.11, and she won't watch charts. So her finance agent hires a Keeper agent." | Run `npm run demo -w apps/payonproof`. Point at the two agents appearing on the dashboard. |
| 0:10 | "She just writes one sentence. Claude turns it into an order; plain code checks it and takes the supplier's address from her own address book, not from the AI." | Timeline: "Claude read it as INV-17 …". |
| 0:18 | "Her money is locked in an escrow contract. The Keeper can trigger it, but can only ever pay that supplier." | Timeline: "Locked 1,110 dUSD … in the escrow". |
| 0:25 | "Every time the Keeper checks, Lena's agent attaches a signed 2 ADA fee on Cardano. Right now EUR/USD is 1.12, not below 1.11. The Keeper answers 409, and the signed fee is simply never submitted. Lena paid nothing." | Grey "voided" edge on the graph; timeline "condition not met, HTTP 409, fee voided". |
| 0:38 | "The second invoice's limit is 1.13, so the condition holds. The Keeper submits the API3-signed rate; the contract verifies the signature, freshness and the limit itself, and pays the supplier at that exact rate." | Timeline "INV-18 paid … escrow verified the signed rate …" with the EVM tx. |
| 0:48 | "Only now does the Keeper's fee settle, on Cardano preprod." | Green edge + pulse; click the cardanoscan link in "Settled payments". |
| 0:55 | "Pay on proof: the agent can't fake the data, can't take the money, and only earns when it delivered. Don't trust your agent, verify it." | Final timeline line: "3 attempts: 1 executed (fee paid), 2 not executed (no fee)". |

For API3 judges: `npm run tamper -w apps/payonproof` shows one valid response executing and the four tampered responses (edited value, too old, another request, another signer) rejected by the contract. Bring your own response with `-- --file response.json` (`pnpm --silent fetch-response EUR/USD > response.json` in `api3/`).

## Evidence

- Escrow contract: TBD
- Cardano preprod fee settlement (x402, Lena → Keeper): TBD
- Escrow execution: TBD

## Limits and roadmap

- **x402 verifies first and settles after the work**, so in theory Lena could double-spend the signed fee's inputs in between. Fees are small; the fix is a Masumi escrow (lock the fee first, release on success), already sketched in `reference/x402-cardano-demo/masumi/`.
- A signature proves Nodary said it, not that it is true; Lena still trusts the data source. The Keeper could pick a favorable signed rate within the 5-minute window; a shorter window narrows that.
- FX closes for the weekend, so the escrow accepts a rate up to 3 days old (the response itself must be signed within 5 minutes).
- Any Airnode feed can be a trigger: flight delays, commodity prices, crypto prices. Business model: a fee per successful execution, nothing for watching.
