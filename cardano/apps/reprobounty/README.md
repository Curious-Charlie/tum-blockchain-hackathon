# D5 ReproBounty: paid, verified paper reproduction with an on-chain certificate

Design: `docs/DESIGN.md` §4. Shared infrastructure: `packages/core`.

## Roles and wallets

| Role | Agent | Does |
|---|---|---|
| `REQUESTER` | Requester (journal) | posts the bounty and pays for a verified reproduction (x402) |
| `REPLICATOR` | Replicator agent | reproduces the paper; pays compute and verifier; publishes the certificate |
| `COMPUTE` | Compute agent | sells sandboxed code runs |
| `VERIFIER` | Verifier agent | spot-checks the evidence bundle |

Ports: 4150-4159.

## Run

```sh
cd cardano
npm run dashboard                         # terminal 1: http://127.0.0.1:4000
npm run wallets -w apps/reprobounty -- --fund   # once
npm run demo -w apps/reprobounty                # terminal 2
```

## 60-second demo script

TBD
