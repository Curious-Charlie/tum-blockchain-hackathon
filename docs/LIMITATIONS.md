# Honest limitations

[中文版](LIMITATIONS.zh.md)

## 1. With x402, the seller holds an unsettled payment and carries the risk

How "pay only if verified" works today: the journal (buyer) signs a Cardano transaction that pays the Replicator 5 tUSDM and sends it with the request. The Replicator (seller) keeps that signed transaction while it does the work, and it is submitted on chain only if the work passes verification. If the work fails, the transaction is simply never submitted, so the buyer pays nothing.

The weak side is the seller's:

- **The signed payment is only valid for about 10 minutes.** Its validity interval ends at `maxTimeoutSeconds` (600 s) after the quote. If the work takes longer, the payment can no longer be submitted.
- **The buyer can double-spend before settlement.** Until the seller submits the transaction, the buyer still controls the inputs it spends. A dishonest buyer can spend one of them elsewhere in the meantime; the seller's transaction then fails and the work goes unpaid, including the compute and verifier fees the Replicator already paid.
- Today this is acceptable because a run takes about 2 minutes and costs the Replicator 2 tUSDM. It does not scale to long or expensive jobs.

**Upgrade: Masumi escrow, implemented as `--escrow` for the bounty.** The journal first locks the 5 tUSDM in Masumi's escrow contract on Cardano, and the Replicator works against funds that are already locked. It puts the result hash into the escrow and collects after the unlock time; if verification fails it authorizes a refund, and if it never delivers the journal takes the money back after the submit-result deadline. This removes the 10-minute window and the double-spend risk. Its own costs:

- The Replicator waits for its money: the shortest deadlines Masumi's rules allow put the unlock time 32 minutes after the quote (refund after a no-show: 17 minutes).
- Collecting and timeout refunds are separate transactions that someone has to send (`npm run escrow -- finish`); nothing happens automatically.
- The journal's dispute path (`SetRefundRequested`, then the Masumi admins) is not wired up.
- x402 pay-on-success stays the default because it settles in one request.

## 2. Other limits

- **Sandbox.** The Compute agent runs only allowlisted, hash-pinned packages, in a fresh temporary directory with an empty environment and a 30 s timeout. That is not a real sandbox: a container with no network and CPU and memory limits is on the roadmap.
- **One demo paper.** The pipeline is general, but the demo runs one small paper (Datasaurus, CHI 2017) whose statistics step the Verifier re-runs independently. Other papers need their own replication package and re-run step.
- **Evidence storage.** The certificate on chain commits to the evidence bundle's hash; the bundle itself is a local file. Content-addressed storage (for example IPFS) is next.
- **The Verifier is trusted for its check.** It is paid whatever it finds, so it has no reason to wave a bundle through, but it is a single party. A second, independent verifier is the next step.
- **Compute track records are seeded.** The Replicator's ledger of compute agents starts from a made-up history (`reputation.seed.json`) so the demo has agents with different records; real runs add to it. Deriving it from certificates on chain is next.
- **Testnet only.** Everything runs on Cardano preprod with test tokens.
