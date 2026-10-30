# D1 PayOnProof: conditional payment keeper

Design: `docs/DESIGN.md` §4. Shared infrastructure: `packages/core`.

## Roles and wallets

| Role | Agent | Does |
|---|---|---|
| `LENA` | Lena's finance agent | pays the Keeper's service fee (x402) |
| `KEEPER` | Keeper agent | executes the invoice when the condition holds; earns the fee |

Ports: 4110-4119.

## Run

```sh
cd cardano
npm run dashboard                         # terminal 1: http://127.0.0.1:4000
npm run wallets -w apps/payonproof -- --fund   # once
npm run demo -w apps/payonproof                # terminal 2
```

## 60-second demo script

TBD
