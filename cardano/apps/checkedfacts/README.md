# D2 CheckedFacts: research paid only when it passes a fact-check

Design: `docs/DESIGN.md` §4. Shared infrastructure: `packages/core`.

## Roles and wallets

| Role | Agent | Does |
|---|---|---|
| `CUSTOMER` | Shop owner | buys a research report (x402) |
| `RESEARCHER` | Research agent | writes the report; pays the fact-checker |
| `CHECKER` | Fact-checker agent | checks claims against their sources; paid per batch |

Ports: 4120-4129.

## Run

```sh
cd cardano
npm run dashboard                         # terminal 1: http://127.0.0.1:4000
npm run wallets -w apps/checkedfacts -- --fund   # once
npm run demo -w apps/checkedfacts                # terminal 2
```

## 60-second demo script

TBD
