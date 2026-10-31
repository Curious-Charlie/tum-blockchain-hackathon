# PayOnProof, single chain (API3 only)

A treasury agent pays a EUR supplier invoice in a USD stablecoin once EUR/USD, **as signed by the Nodary Airnode v2 on AirnodeHub**, is below the payer's limit. A Keeper agent watches the rate and submits the signed response; the contract checks it and, in **one transaction**, pays the supplier at the signed rate, pays the Keeper its fee and refunds the rest. Everything runs on Base Sepolia: no Cardano, no Masumi, no second chain.

## Why one chain

The two-chain version (main branch) paid the Keeper's fee on Cardano through Masumi escrow and the invoice on Base Sepolia. The fee could only be released after the Keeper reported a result hash, and Lena needed a dispute window to check it. With the fee locked in the same contract as the invoice, the contract pays the fee **in the same transaction that pays the invoice**, so:

- there is no result to report and nothing to dispute: the fee exists only if the payment happened;
- the Keeper is paid for the one thing that matters (a valid, fresh, signed rate that moved the money), and cannot be paid for anything else;
- one chain, one stablecoin, one set of keys.

## Contract: `InvoiceEscrowV2`

[`contracts/payonproof/InvoiceEscrowV2.sol`](contracts/payonproof/InvoiceEscrowV2.sol), deployed at [`0xec121b9f115999031d5d2f746affe4d671791a12`](https://sepolia.basescan.org/address/0xec121b9f115999031d5d2f746affe4d671791a12) ([deploy tx](https://sepolia.basescan.org/tx/0x976e876c5eb03e27794cc0d106c0bcfe89595a92c41e2e2111fb08774de7149a)). v1 (`InvoiceEscrow.sol`) is unchanged.

- `createOrder(invoiceRef, payee, token, amountEurCents, maxRate, deadline, keeper, keeperFee)`: the payer locks `€ amount × maxRate` plus the Keeper's fee.
- `execute(orderId, timestamp, data, signature)` makes every v1 check on the signed response:
  - **signer**: the Nodary Airnode v2 address `0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0` (constant);
  - **request**: the stored EUR/USD request hash `0x5ccc3aa9…d3d0` goes into the digest, so a response to another feed or projection recovers another signer;
  - **freshness**: the response was signed at most **2 minutes** ago (v1: 5), and Nodary took the rate at most 3 days ago (FX closes for the weekend);
  - **condition**: signed rate strictly below the order's limit, order open, before its deadline, paid once.
  - Then in the same transaction: payee gets `€ amount × signed rate`, `msg.sender` gets `keeperFee`, the payer gets the rest.
- **Keeper exclusivity with a public fallback**: for 10 minutes after creation only the chosen Keeper may execute (`KeeperOnly`); after that anyone may, and earns the fee. An order never depends on one Keeper staying online.
- `cancel(orderId)`: the payer takes back the deposit and the fee of an unpaid order.
- `InvoicePaid` records the `requestHash` and the response `timestamp` the payment relied on, with rate, payout, fee and refund. These events are also the Keeper's public track record.

`forge test --match-contract InvoiceEscrowV2`: 13 tests on a real Nodary EUR/USD response, including the split, the exclusive period and the public fallback, cancel with fee refund, and the four tamper cases.

Run it: `cd api3 && pnpm install && forge test && pnpm payonproof && pnpm payonproof:tamper` (needs `PRIVATE_KEY` in `api3/.env` for Lena and `KEEPER_B_EVM_PRIVATE_KEY` in `cardano/apps/payonproof/.env` for the Keeper, both with Base Sepolia ETH; the Keeper needs aUSD for x402).

## The agents (EVM only, viem)

[`src/payonproof/run.ts`](src/payonproof/run.ts) (`pnpm payonproof`):

1. **Lena chooses a Keeper by its record on chain**: the InvoicePaid events (v1 and v2 escrows) with the Keeper's account as executor. Keeper Swift has 10 paid executions on v1 → accepted (minimum 3).
2. Lena opens two orders, each locking the invoice at her limit plus Swift's 0.50 dUSD fee: **INV-41** (€250 to Café Verde, pay when EUR/USD < 1.13, above the live rate) and **INV-42** (€180 to Fazenda Alta, pay when EUR/USD < 1.11, below it, deadline 3 minutes).
3. **Keeper Swift's loop** polls Nodary's signed EUR/USD every 20 s and checks signer and request off chain. When an order's condition holds it first **buys a second signed rate over x402** (Frankfurter on AirnodeHub, 0.01 aUSD, signer and request checked) and executes only if the two agree within 1 %.
4. INV-41 executes: supplier and Keeper are paid in one transaction. INV-42 never meets its limit; after its deadline Lena cancels it and gets the deposit and the fee back.

[`src/payonproof/tamper.ts`](src/payonproof/tamper.ts) (`pnpm payonproof:tamper`): opens a €100 order, dry-runs four tampered responses against the deployed contract (eth_call from the Keeper's account, no gas) and then executes the valid, fresh one.

No LLM is in the money path: the contract decides from signed data, the agents only choose and trigger.

## Base Sepolia run (Sat 2026-10-31, ~12:53 UTC)

Live Nodary EUR/USD 1.116325 (Friday's close, FX is closed for the weekend), Frankfurter 1.1175 (0.11 % apart).

| Step | Transaction |
|---|---|
| Deploy InvoiceEscrowV2 (Lena) | [0x976e876c…](https://sepolia.basescan.org/tx/0x976e876c5eb03e27794cc0d106c0bcfe89595a92c41e2e2111fb08774de7149a) |
| Lena approves the escrow for dUSD | [0x83591370…](https://sepolia.basescan.org/tx/0x8359137043a5f81fac012a8face7fa678eb1077e77aae2491af39fa316dd86d1) |
| Lena chooses Keeper Swift: 10 InvoicePaid as executor on v1, latest | [0x02e505a6…](https://sepolia.basescan.org/tx/0x02e505a6cde1771c59dc2e9be67b0e27b3f5d048d24b20f7ead02bc7f9c5316e) |
| INV-41 opened (order 1): €250 to Café Verde when EUR/USD < 1.13; locks 282.50 dUSD + 0.50 fee | [0x72c8807c…](https://sepolia.basescan.org/tx/0x72c8807c61b7b829c236e6ed95880e7115aed65542d9e3dfea5c7e5ae80e44bd) |
| INV-42 opened (order 2): €180 to Fazenda Alta when EUR/USD < 1.11, deadline 3 min; locks 199.80 dUSD + 0.50 fee | [0xdc0400c3…](https://sepolia.basescan.org/tx/0xdc0400c3a1a84107b470a244452d471643307449be8146c24500558a19017017) |
| Swift buys Frankfurter's signed EUR/USD over x402 (0.01 aUSD, settled by the facilitator): 1.1175 vs Nodary 1.116325 | [0x0f925cc4…](https://sepolia.basescan.org/tx/0x0f925cc4d83d2f1f36f9456eae173e93f17a64149f037f3e31e59415c82d2b9e) |
| **INV-41 paid in one transaction** at 1.116325: 279.08125 dUSD → Café Verde, 0.50 dUSD → Keeper Swift, 3.41875 dUSD → Lena | [0x9b82dd90…](https://sepolia.basescan.org/tx/0x9b82dd907361478d5b67f6d28d19368540fffe7141e5bf6912e7664442b5e104) |
| INV-42: 9 rounds at 1.116325 ≥ 1.11, never executed; after the deadline Lena cancels and gets 200.30 dUSD (deposit + fee) back | [0x262da66d…](https://sepolia.basescan.org/tx/0x262da66d52d8172827b94323bf6fa2236578dee3e93996ef7deb0eee0be634d9) |

(A first attempt created INV-41 and then hit a 429 from the public RPC; the rerun kept the open order instead of locking the money twice.)

### Tamper test (4 rejected, 1 accepted)

Order 3 (€100, pay when EUR/USD < 1.13, Keeper Swift, fee 0.10 dUSD): [0x71909926…](https://sepolia.basescan.org/tx/0x71909926d49a68121e1b0d8154459b7eafaebd8beb8095040ddcd647dfa5d1c6). The rejections are dry runs (eth_call from Swift's account) against the deployed contract, so the errors are the contract's own:

| Case | Contract's answer |
|---|---|
| 1 · real response, price edited to 1.0163 | `NotSignedByAirnode(0xE371…c0FB)` |
| 2 · real response signed 2026-10-30 10:21 UTC (limit 2 minutes) | `ResponseTooOld(1793355665)` |
| 3 · real, fresh Nodary response to another request (BTC/USD) | `NotSignedByAirnode(0xC778…2707)` |
| 4 · `{"price":1.0163,…}` signed by a random key | `NotSignedByAirnode(0x79a3…1035)`, the impostor's address |
| (extra) valid response, submitted by Lena instead of Keeper Swift within 10 minutes | `KeeperOnly(0x1d87…F221, 1793452058)` |
| **valid, fresh response from Keeper Swift** | **paid**: 111.6325 dUSD to the supplier, 0.10 dUSD to Swift, 1.3675 dUSD back to Lena, [0x1f244a7f…](https://sepolia.basescan.org/tx/0x1f244a7fd44ea8cf46b761e9689a505a3c5d58cbc1fadbe9bf58c6385b456609) |

All transactions above were confirmed by their receipts (status success).

## Honest limitations

- **Testnet and demo money**: Base Sepolia, DemoUSD (mintable demo stablecoin), aUSD from the AirnodeHub faucet.
- **FX is closed on weekends**: the contract accepts a rate taken up to 3 days ago (the response itself must be at most 2 minutes old), so on a Saturday it pays at Friday's close. A production deployment would use a shorter rate age on weekdays.
- **The contract trusts one source**: only Nodary's signature gates the money. The Frankfurter cross-check is the Keeper's own discipline (it refuses to act on an outlier), not a contract rule.
- **The Keeper record is a count, not a reputation system**: InvoicePaid events prove executions that the contract accepted; they say nothing about Keepers that never executed. The script reads them from Blockscout's logs API because the public RPC serves logs 200 blocks at a time.
- **One Keeper bid in this run**: the choosing rule (cheapest acceptable bid, record of at least 3 paid executions) ran over a single bid; the other Keeper accounts were busy on another branch.
- **Exclusive period on chain, not in the live run**: the live run shows the chosen Keeper executing within its 10 minutes (and the tamper script shows `KeeperOnly` for anyone else); the public fallback after 10 minutes is shown in the forge tests.

## Draft: API3-only section for the main README (not applied)

> **PayOnProof (API3, single chain).** A treasury agent pays a EUR invoice in USD once EUR/USD, signed by the Nodary Airnode v2 on AirnodeHub, is below the payer's limit. `InvoiceEscrowV2` on Base Sepolia checks the signer, the exact request, a 2-minute freshness window and the limit, then pays the supplier `€ × signed rate`, pays the Keeper agent its fee and refunds the payer, all in one transaction. The payer agent chooses its Keeper by its on-chain InvoicePaid record; the Keeper buys a second signed rate (Frankfurter) over x402 before it executes. Four tampered responses (edited value, stale, another request, another signer) are rejected by the contract on chain. Contract [`0xec12…1a12`](https://sepolia.basescan.org/address/0xec121b9f115999031d5d2f746affe4d671791a12), details in [`api3/PAYONPROOF_SINGLE_CHAIN.md`](api3/PAYONPROOF_SINGLE_CHAIN.md).
