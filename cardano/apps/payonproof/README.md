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

Ports: Keeper 4110, look-alike Keeper (`--attack`) 4111, local anvil fallback 4118.

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

**EVM network.** The escrow is deployed on **Base Sepolia** (addresses in `deployments.json`), and the demo and tamper test use it by default; the Keeper's and Lena's EVM accounts need a little Base Sepolia ETH for gas. Fallback without ETH or internet to Base: `--evm anvil` (or `EVM_NETWORK=anvil`) starts a local anvil chain on port 4118, deploys the same contracts and runs against them. Cardano is always real preprod. To deploy afresh on Base Sepolia:

```sh
npm run deploy -w apps/payonproof -- --dry-run      # prints the cost; the L1 data fee dominates
npm run deploy -w apps/payonproof                   # deploys InvoiceEscrow, funds the Keeper's EVM account
```

## 60-second demo script

Before: dashboard open at http://127.0.0.1:4000 (Reset it), a terminal in `cardano/`. Run once beforehand so Claude's answers are cached. The command takes about 40 seconds; talk over it.

| Time | Say | Show / do |
|---|---|---|
| 0:00 | "Lena runs a coffee roastery in Munich. She owes her Colombian supplier €1,000 but holds dollars, and wants to pay when the euro is cheap, below 1.11, without watching charts. So her finance agent hires a Keeper agent." | Run `npm run demo -w apps/payonproof`. The two agents appear on the graph. |
| 0:10 | "She writes one sentence. Claude turns it into an order; plain code checks it and takes the supplier's address from her own address book, never from the AI. The money is locked in an escrow contract: the Keeper can trigger it, but it can only ever pay that supplier." | Timeline: "Claude read it as INV-17 …"; blue arrow Lena → Invoice escrow ("Locked 1,110 dUSD …", basescan link). |
| 0:20 | "Each check comes with a signed 2 ADA fee on Cardano. EUR/USD is 1.12, not below 1.11, so the Keeper answers 409, and the signed fee is simply never submitted. Lena paid nothing for that check." | Grey "voided" edge; timeline "condition not met, HTTP 409, fee voided". |
| 0:32 | "Now a second invoice, limit 1.13, so the condition holds. The Keeper hands the API3-signed rate to the contract, which checks the signature, the freshness and the limit itself, and pays the supplier at exactly that rate." | Blue arrow Invoice escrow → Fazenda Alta on the graph; timeline "INV-18 paid …", click "escrow tx on basescan ↗". |
| 0:44 | "Only now does the Keeper's fee settle on Cardano, and the Keeper publishes a receipt linking the fee to the payment it bought." | Green edge + pulse. Under "Settled payments" open the cardanoscan link; open the receipt's Metadata tab. |
| 0:55 | "Pay on proof: the agent can't fake the data, can't take the money, and only earns when it delivered. Don't trust your agent. Verify it." | Last line: "3 attempts, Lena paid 2 tADA: 1 executed, 2 not executed (no fee)". |

Extra 10 seconds if asked about safety: `npm run demo -w apps/payonproof -- --attack` adds a phishing message pointing the agent at a look-alike Keeper; AgentGuard refuses before anything is signed (red "blocked" edge).

For API3 judges: `npm run tamper -w apps/payonproof` opens an order, shows the four tampered responses (edited value, too old, another request, another signer) rejected by the contract, then one valid, fresh response executing it. Bring your own response with `-- --file response.json` (`pnpm --silent fetch-response EUR/USD > response.json` in `api3/`).

## Evidence (2026-10-30)

**Base Sepolia** (chain 84532):

- InvoiceEscrow [`0x63e2b722725eda487a9d76962ef4633dcc5e571a`](https://sepolia.basescan.org/address/0x63e2b722725eda487a9d76962ef4633dcc5e571a) (deploy tx [`0x37a2b603…`](https://sepolia.basescan.org/tx/0x37a2b6030c8991943cbddfc291d106b97d5ec4682e04d94a896c9c8f050c37c4)); request hash `0x5ccc3aa9…d3d0` (Nodary EUR/USD), `maxRateAge` 3 days
- DemoUSD (dUSD, 6 decimals) [`0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf`](https://sepolia.basescan.org/address/0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf)
- Demo run: Lena locks INV-17 [`0x07f495f8…`](https://sepolia.basescan.org/tx/0x07f495f8f1c8e32d316ceb85947fc95783fbb2a2cdf71544e580ba8789d8e6ce) and INV-18 [`0xc3fe731d…`](https://sepolia.basescan.org/tx/0xc3fe731dac42ed99561d348b83fc371900cf86ad3cecc63c057a25603c3998cf); the Keeper executes INV-18 at the signed EUR/USD 1.1202, paying 448.08 dUSD to the supplier: [`0x43e772f3…`](https://sepolia.basescan.org/tx/0x43e772f3e4d00b477018ed3f96f4e49c71cdf84c9313fb4771c373fb61e93e8b). INV-17 (limit 1.11) stays open.
- Tamper test: order 3 [`0xc8bdc470…`](https://sepolia.basescan.org/tx/0xc8bdc470760bf540d48e156aef228da38c24b53def8e7dd6ae12ff938b1845ed); edited value, too old, another request (BTC/USD) and another signer were all rejected by the contract (`NotSignedByAirnode`, `ResponseTooOld`); the valid response executed: [`0x0b240589…`](https://sepolia.basescan.org/tx/0x0b240589f0cc88289bd17d4ef92c864dc6182be30af35dca67d097323443ed24)

**Cardano preprod** (x402 fee settlements, Lena's finance agent → Keeper agent, 2 tADA each, each settled only after the escrow paid):

- Base Sepolia run: fee [`4a5300fe…`](https://preprod.cardanoscan.io/transaction/4a5300fe0927359c8c1ab84e32befb86e3b14296c4be7e2139cd3c5b754d1534), Keeper's CIP-20 receipt [`d578fe53…`](https://preprod.cardanoscan.io/transaction/d578fe53cd06c3c1d50acba2ee244ee61cc378c5527ec9cf4efd6d0d45dfc7df) (Metadata tab)
- Run after the core merge (receipt published from the Seller's `onSettled` hook): escrow payout [`0x04d3391f…`](https://sepolia.basescan.org/tx/0x04d3391fa744f2728dae39f6863685c8d19db9a98fa33bc9777aaf4b86840f15), fee [`d5477e11…`](https://preprod.cardanoscan.io/transaction/d5477e116ecff63a33cf6b340feebc9c869604c03d0748576db70b431191a3d5), receipt [`3c9017a0…`](https://preprod.cardanoscan.io/transaction/3c9017a0ee8b8c68e62dd3c197bfb0ad8e670e7b90f0fb141de1332dfd850fde)
- Earlier runs against anvil: [`0203e326…`](https://preprod.cardanoscan.io/transaction/0203e326c6473e654f9f215bd5b4d090d6055dd4f0a36adf62e2b221cd5a15a6), [`f726efd5…`](https://preprod.cardanoscan.io/transaction/f726efd58c66a57e0ed7cd39236a12a7f0d6f6594479b75b17abb6985b88fe8a), receipt [`be4ec11b…`](https://preprod.cardanoscan.io/transaction/be4ec11b4ef4ad900f7ce2bd5ecc091ce848cbeaf4d299694416c4f93d105786)
- Attempts whose condition was not met: HTTP 409, no transaction exists (`cardano/.audit/payonproof-lena.jsonl`, decision `voided`).

## Limits and roadmap

- **x402 verifies first and settles after the work**, so in theory Lena could double-spend the signed fee's inputs in between. Fees are small; the fix is a Masumi escrow (lock the fee first, release on success), already sketched in `reference/x402-cardano-demo/masumi/`.
- A signature proves Nodary said it, not that it is true; Lena still trusts the data source. The Keeper could pick a favorable signed rate within the 5-minute window; a shorter window narrows that.
- FX closes for the weekend, so the escrow accepts a rate up to 3 days old (the response itself must be signed within 5 minutes).
- Any Airnode feed can be a trigger: flight delays, commodity prices, crypto prices. Business model: a fee per successful execution, nothing for watching.
