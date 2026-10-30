# API3 track: Any API in your contract

Contracts that verify AirnodeHub signed responses before acting on them, and scripts to submit responses. Based on the [AirnodeHub hackathon starter](https://github.com/api3dao/airnodehub-hackathon-starter) (MIT).

## PayOnProof InvoiceEscrow

[`contracts/payonproof/InvoiceEscrow.sol`](contracts/payonproof/InvoiceEscrow.sol) pays a EUR invoice in a USD stablecoin once EUR/USD, as signed by the Nodary Airnode v2, is below the payer's limit. The signed rate decides both **whether** the invoice is paid and **how much** (€amount × signed rate); the rest of the deposit goes back to the payer. Anyone (in practice the Keeper agent) can submit a response; the contract checks:

- signer: the Nodary Airnode v2 address `0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0` (constant)
- request: the stored EUR/USD request hash (`pnpm --silent request-hash EUR/USD`), so a response to another feed or projection fails
- time: response signed at most 5 minutes ago; rate taken at most `maxRateAge` ago (3 days, because FX closes for the weekend)
- condition: signed rate strictly below the order's limit; order open and before its deadline; each order pays once

```sh
forge test --match-contract InvoiceEscrow     # 12 tests incl. the four tamper cases, on a real Nodary EUR/USD response
```

Deployment, the end-to-end demo and a tamper-test script judges can run with their own response: [`cardano/apps/payonproof/README.md`](../cardano/apps/payonproof/README.md) (`npm run deploy|demo|tamper -w apps/payonproof`).

Deployed on Base Sepolia: InvoiceEscrow [`0x63e2b722725eda487a9d76962ef4633dcc5e571a`](https://sepolia.basescan.org/address/0x63e2b722725eda487a9d76962ef4633dcc5e571a), DemoUSD [`0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf`](https://sepolia.basescan.org/address/0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf).
