# Honest limitations

[中文版](LIMITATIONS.zh.md)

PayOnProof spans two chains: the invoice money sits in `InvoiceEscrow` on Base Sepolia (EVM), the Keeper's service fee is paid on Cardano preprod. This page lists what each part does and does not guarantee.

## 1. Per-attempt x402: the Keeper holds an unsettled fee

In the per-attempt mode (`--x402`) every attempt carries a fee that Lena's agent has signed but not submitted. The Keeper holds the signed transaction while it checks the rate and executes, and submits it only after the invoice was paid (HTTP 200). If the condition is not met it answers 409 and the transaction is never submitted, so Lena pays nothing.

The weak side is the Keeper's:

- **The signed fee is only valid for about 10 minutes** (`maxTimeoutSeconds` = 600 s after the quote). That fits one attempt, not a job that watches an order for hours.
- **Lena could double-spend before settlement.** Until the Keeper submits the fee, its inputs are still Lena's. A dishonest buyer could spend one of them elsewhere after the Keeper paid gas and the supplier; the fee transaction then fails.

## 2. The fix, now the default: the fee locked in Masumi escrow

By default Lena's agent locks the Keeper's fee in Masumi's escrow contract on Cardano (`vested_pay`, payment V2) before the Keeper starts. The Keeper works against money that is already locked, so there is no 10-minute window and nothing to double-spend. The Keeper watches the order in cycles; when the condition holds it executes on Base Sepolia, puts a result hash into the escrow and collects after the unlock time. If the condition never holds within its watch window, it authorizes a refund and Lena takes her fee back at once; if the Keeper vanishes, Lena takes it back after the result deadline. Both release and refunds ran on preprod (transactions in the [app README](../cardano/apps/payonproof/README.md#evidence)).

What escrow costs:

- **Waiting.** With the shortest deadlines Masumi's rules allow, the Keeper can collect 32 minutes after the quote, and a vanished Keeper's fee comes back after 17 minutes. The watch window is at most about 13 minutes; longer windows need longer deadlines, which push collection further out.
- **Someone has to send the late transactions.** Collecting and timeout refunds are transactions of their own (`npm run escrow -w apps/payonproof -- finish --wait`); nothing happens by itself.
- **The escrow does not check the result.** Masumi's contract stores the Keeper's result hash; it cannot see Base Sepolia. The hash commits to the `execute` transaction and its `InvoicePaid` event, so anyone can check it (`npm run check -w apps/payonproof -- <receipt tx>`), but a false hash is caught by a person or agent during the dispute window, not by the contract. Lena's dispute path (`SetRefundRequested`, then Masumi's admins) is not wired up.

## 3. Who enforces which split

- **The invoice payment: a contract.** `InvoiceEscrow` pays the supplier fixed in the order exactly `€ amount × signed rate` and returns the rest of the deposit to Lena, in one transaction. Neither the Keeper nor an AI can change the payee or the amount.
- **The Keeper's fee: a contract, with the result hash written by the Keeper.** The Masumi escrow decides when the fee can move (collect after unlock, refund on authorization or after the deadline). Whether the Keeper really executed is attested by the Keeper's own result hash, checkable by anyone but not by the escrow (see 2).
- **Nothing is split by an agent on its own.** No agent moves money outside these two contracts and AgentGuard's caps.

## 4. Where a Keeper's track record comes from

Lena's agent computes each Keeper's record from public chain data only: the Keeper's CIP-20 receipts on Cardano (transactions its address signed), each checked against the `InvoicePaid` event on Base Sepolia that the receipt names (right contract, right order, executed from the Keeper's EVM account, which the Keeper proves with a signature). There is no seed data. Limits:

- Only deliveries count. Refunds and no-shows are visible on chain (escrow transactions) but are not yet counted against a Keeper.
- A Keeper could build a record by executing its own invoices (wash trading). The trial rule (new Keepers get invoices up to €250 until they have 2 verified executions) slows that down; it does not stop it.
- The receipt scan reads a Keeper's latest 100 Cardano transactions.

## 5. Weekend FX

FX markets close on Friday evening, and Nodary's EUR/USD can stop updating after about 22:00 UTC. The escrow accepts a rate up to 3 days old (`maxRateAge`), while the signed response itself must be at most 5 minutes old, so a Keeper can still execute over the weekend, at Friday's closing rate. That is the last market price, not a live one; for urgent payments that is acceptable, for others a payer may prefer to wait. Result of the check after the close: see the [app README](../cardano/apps/payonproof/README.md#weekend-fx).

## 6. Other limits

- **The signature proves who said it, not that it is true.** Lena still trusts Nodary for the EUR/USD value. Within the 5-minute window a Keeper could pick the more favorable of several signed rates; a shorter window narrows that.
- **Two chains, no bridge.** The fee (Cardano) and the payment (Base Sepolia) are linked by hashes and receipts, not by a cross-chain message.
- **Test money.** dUSD is a demo stablecoin; everything runs on Cardano preprod and Base Sepolia.
