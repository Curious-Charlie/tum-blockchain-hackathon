# Agent pays verified suppliers only (prototype)

A treasury agent is told to pay supplier invoices. **The contract, not the agent, decides whether a supplier gets paid**: `CompliantInvoiceEscrow` releases the money only if, at payment time, a fresh response signed by the **Companies House Airnode** (UK company register, on AirnodeHub) says that the supplier's company is `active`, and a fresh Nodary-signed EUR/USD is below the payer's limit. Supplier, Keeper fee and refund settle in one transaction, and the contract records on chain which signed data it relied on. Everything runs on Base Sepolia.

This is not a spending policy (no budgets, allowlists or kill switch) and no LLM is in the money path. The gate is the contract checking external signed facts.

## Why signed, fresh data matters

- **Forged "active"**: an agent (or a compromised Keeper) that could claim "active" would pay a dissolved shell company. The contract recovers the Companies House Airnode's signer from the response, so an edited or self-signed "active" fails.
- **Swapped response**: a genuine, fresh "active" response for *another* company must not count. The payer's agent fixes the Companies House request hash (company number + projection) in the order when it opens it, and that hash is part of the signed digest. A response for any other company recovers a different signer.
- **Stale data**: a company can be dissolved after it was onboarded. The contract accepts a company response signed at most **2 minutes** before payment (the same limit as the rate), so the check happens at payment time, not at onboarding.
- **Forged "clean" wallet**: paying a sanctioned wallet violates sanctions law. This prototype does not yet check the wallet (see gaps).

## Contract

[`contracts/payonproof/CompliantInvoiceEscrow.sol`](contracts/payonproof/CompliantInvoiceEscrow.sol), deployed at [`0xb975d0c7557098ca4d29aaf2c27817f37fcfcdba`](https://sepolia.basescan.org/address/0xb975d0c7557098ca4d29aaf2c27817f37fcfcdba) ([deploy tx](https://sepolia.basescan.org/tx/0x06e2e30f918ac9b2b33cc1f7f1916047b4d380a02ad8a2439405ec36913838fc)). It is [`InvoiceEscrowV2`](PAYONPROOF_SINGLE_CHAIN.md) plus the company check:

- `createOrder(invoiceRef, payee, token, amountEurCents, maxRate, deadline, keeper, keeperFee, companyRequestHash)`: the payer locks `€ × maxRate` plus the Keeper's fee. `companyRequestHash = keccak256(JSON.stringify(["getCompanyProfile", [["company_number", "<number>"]], [["status", "/company_status"]]]))` (`companyRequestHash()` in [`src/payonproof/companies-house.ts`](src/payonproof/companies-house.ts)).
- `execute(orderId, fx, company)`, each a signed `{timestamp, data, signature}`:
  - company: `AirnodeV2Attestation.verify(COMPANIES_HOUSE = 0x3922…4bFF, order.companyRequestHash, …)`, signed at most 2 minutes ago, and `data` must be exactly `{"status":"active"}`, else `CompanyNotActive(data)`. The projection keeps the signed data that small, so the contract compares bytes and parses nothing.
  - fx: every v1 check (Nodary signer, EUR/USD request, 2-minute response, rate at most 3 days old, rate below the limit).
  - then in one transaction: payee gets `€ × signed rate`, `msg.sender` gets the fee (only the chosen Keeper for the first 10 minutes, then anyone), the payer gets the rest; each order pays once.
  - events: `InvoicePaid` and `ComplianceEvidence(orderId, fxSigner, fxRequestHash, fxTimestamp, companySigner, companyRequestHash, companyTimestamp)`.
- `cancel(orderId)`: the payer takes back deposit and fee of an unpaid order.

`forge test --match-contract CompliantInvoiceEscrow`: 11 tests on real responses fetched together (Nodary EUR/USD; Companies House 02627406 active, 00445790 active, 05514098 dissolved): normal split, dissolved company rejected, exclusive period and public fallback, cancel, paid twice, rate checks, and the company tamper tests (dissolved edited to active, stale, another active company's response, another signer).

## Run it

```sh
cd api3 && pnpm install && forge test
pnpm payonproof:compliance
```

Lena's key is `PRIVATE_KEY` in `api3/.env`, the Keeper's is `KEEPER_B_EVM_PRIVATE_KEY` in `cardano/apps/payonproof/.env`. Both need Base Sepolia ETH, and the Keeper needs aUSD: it pays 0.01 aUSD over x402 for each Companies House response.

## Base Sepolia run (Sat 2026-10-31, 13:00 UTC)

Lena's agent is asked to pay both invoices and opens both orders. Company numbers come from the register: 02627406 is DYSON LIMITED (active), 05514098 is SCL GROUP LIMITED (dissolved). The payee addresses are demo addresses, not the companies' wallets.

| Step | Transaction |
|---|---|
| Lena approves the escrow for dUSD | [0xe3bbd2cc…](https://sepolia.basescan.org/tx/0xe3bbd2cc9c5f4008101ac46137c312b90658cd9200807bf064787b0800f7a229) |
| INV-51 (order 1): €120 to the supplier with company number 02627406, request `0x0410be06…`; locks 135.60 dUSD + 0.50 fee | [0x1dff7cf2…](https://sepolia.basescan.org/tx/0x1dff7cf23d0d476640aee26c884aa9daf4c85fb2e570ee91e845a8b03b7103f5) |
| INV-52 (order 2): €90 to the supplier with company number 05514098, request `0x6ad3035d…`; locks 101.70 dUSD + 0.50 fee | [0xdb9b3827…](https://sepolia.basescan.org/tx/0xdb9b38273a16b4eeb82537284ac3f6c4e726879654df4f993971cd3b4e432ec1) |
| Keeper Swift pays 0.01 aUSD over x402 for Companies House 02627406 → `{"status":"active"}` | [0x4fa9f4c5…](https://sepolia.basescan.org/tx/0x4fa9f4c5305d225ba5f75efea06e2e95b03b6d40f69eb374453018769ddca7eb) |
| Keeper Swift pays 0.01 aUSD over x402 for Companies House 05514098 → `{"status":"dissolved"}` | [0x22ad3002…](https://sepolia.basescan.org/tx/0x22ad3002cd02bdae900a40eb7a7ad7615b21716d60fc79758837286c2324371f) |
| **INV-51 paid in one transaction** at EUR/USD 1.116325: 133.959 dUSD → supplier, 0.50 dUSD → Keeper Swift, 1.641 dUSD → Lena; `ComplianceEvidence` names Companies House `0x3922…4bFF`, request `0x0410be06…`, signed at 1793451612 | [0x798ff3f0…](https://sepolia.basescan.org/tx/0x798ff3f0b992e61580066bac4ebdba8cdbd5f07e9b48c0b660e00cb0ea752755) |
| **INV-52 rejected on chain**: Swift submits the genuine signed `{"status":"dissolved"}`; the transaction reverts with `CompanyNotActive({"status":"dissolved"})` | [0x7db77ff7…](https://sepolia.basescan.org/tx/0x7db77ff7f367adb0da7dd67129e708ea3ba00b4fb0130456b91e0281424f1944) (status: reverted) |
| INV-52 cancelled: 102.20 dUSD (deposit + fee) back to Lena | [0x69731d74…](https://sepolia.basescan.org/tx/0x69731d74e63adcfacd16a3b54923ea4896c130ee53d394dca5579f71ad6aa083) |

### Tamper test on the company response (4 rejected, 1 accepted)

Dry runs (eth_call from Keeper Swift's account) against the deployed contract, right before the payment above:

| Case | Contract's answer |
|---|---|
| 1 · INV-52: the dissolved company's real response, edited to `{"status":"active"}` | `NotSignedByAirnode(0x1Dc0…4379)` |
| 2 · INV-51: a real "active" response for 02627406, signed 12:55:58 UTC (over 2 minutes old) | `ResponseTooOld(0x3922…4bFF, 1793451358)` |
| 3 · INV-52: a real, fresh "active" response for another company (02627406) | `NotSignedByAirnode(0x3798…3790)` |
| 4 · INV-52: `{"status":"active"}` signed by a random key | `NotSignedByAirnode(0xC0a3…9241)`, the impostor's address |
| **INV-51: fresh, genuine "active" response** | **paid**, [0x798ff3f0…](https://sepolia.basescan.org/tx/0x798ff3f0b992e61580066bac4ebdba8cdbd5f07e9b48c0b660e00cb0ea752755) |

Every transaction above was confirmed by its receipt: all succeeded except 0x7db77ff7…, which reverted as intended.

## Honest gaps

- **Wallet ↔ company binding is not proven.** The contract proves that company 02627406 is active, not that the payee address belongs to it: the payer's agent pairs them when it opens the order. Next step: check in the contract a signed Web3.bio ENS/Basename resolution that links the company's domain to the payee address.
- **The wallet is not screened (PublicAML cut for time).** We confirmed that PublicAML flags `0x098B716B8Aaf21512996dC57EB0615e2383E2f96` as `CRITICAL` (score 100, OFAC SDN), and that an unknown address (our demo supplier) comes back in `not_found`. A projection whose path is missing is refused with HTTP 400, so a known address (`{"level": "/entities/0/risk/level"}`) and an unknown one (`{"not_found": "/not_found/0/reason"}`) need two different request hashes. The planned design stores both hashes in the order, rejects anything but `LOW` with `PayeeFlagged`, and lets `not_found` pass but records it in the evidence event. That is a policy choice ("unknown is not clean" per PublicAML's own docs; a stricter deployment would reject it).
- **UK only.** Companies House covers UK companies. Other countries need another register, e.g. GLEIF (LEI) for legal entities worldwide.
- **Exact bytes.** The contract accepts only `{"status":"active"}`. Any other status (dissolved, liquidation, administration, …) is rejected. That fails closed, but it would also reject an active company if the Airnode ever changed its formatting.
- **Testnet.** Base Sepolia, DemoUSD (a mintable demo stablecoin), aUSD from the AirnodeHub faucet. FX is closed on weekends, so the rate is Friday's close (accepted up to 3 days old; the response itself must be at most 2 minutes old).
