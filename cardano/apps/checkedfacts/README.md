# D2 CheckedFacts: research you only pay for if it passes a fact-check

A shop owner buys a competitor report from an AI research agent over x402 on Cardano. Before delivering, the research agent **hires and pays a second agent, a fact-checker**, which opens every cited page, checks in code that each quote is really there, and has Claude Haiku judge whether the quote supports the claim. **The shop owner's payment only settles if the report passes**; otherwise the signed payment is never submitted and the shop owner pays nothing. Bad research is the research agent's loss: it already paid for the checks.

Design: `docs/DESIGN.md` §4 (D2). Shared infrastructure: `packages/core`.

```
Shop owner ──3 tUSDM, held──▶ Research agent ──0.2 tUSDM per claim──▶ Fact-checker agent
 (CUSTOMER)   settles only     (RESEARCHER)     x402, paid per batch     (CHECKER)
              if checks pass   Sonnet + web      through AgentGuard      fetches sources,
                                search                                    quote match in code,
                                                                          Haiku judges support
```

## The money rule (deterministic, `verdict.ts`)

AI interprets, code decides. Per claim the checker returns one of:

| Verdict | How it is decided |
|---|---|
| `quote_not_found` | **code**: the source page was fetched, but the quote is not on it (normalized exact match: case, punctuation and typographic quotes ignored; quotes under 6 words fail) |
| `unverifiable` | **code**: the source could not be fetched (network error, HTTP error, bot wall, PDF, almost no text) |
| `supported` / `unsupported` | **Haiku**, only after code proved the quote is on the page: does the quote, in its page context, support the claim? |

Then `gate()` decides whether the shop owner pays:

- `checkable` = claims that are not `unverifiable`; `pass rate` = `supported / checkable`
- **settle ⇔ checkable ≥ 5 and pass rate ≥ 85%** (8 claims: at most one miss)
- An unverifiable claim counts as neither fabricated nor supported: a dead or bot-blocked source is not the researcher's lie, but the report must still have at least 5 checkable claims, so nobody can pass by citing pages that cannot be opened.

The research agent self-checks its quotes (same deterministic match on its own copy of each page) and drops failures before it pays for checks. The customer does not have to trust that: the paid, independent check is what gates the money.

## Setup and run

```sh
cd cardano
npm run dashboard                                  # terminal 1, http://127.0.0.1:4000 (already running? skip)
npm run wallets -w apps/checkedfacts               # balances; CUSTOMER and RESEARCHER need tADA + tUSDM

npm run prewarm -w apps/checkedfacts               # optional: research + checks WITHOUT payments, fills the caches
npm run demo -w apps/checkedfacts                  # happy path: report passes, 3 tUSDM settle (≈1-2 min)
npm run demo -w apps/checkedfacts -- --sloppy      # failure path: report fails, the shop owner pays nothing
npm run attack -w apps/checkedfacts                # AgentGuard blocks a prompt-injected payment (no chain, ≈5 s)
npm test -w apps/checkedfacts                      # quote matching, the gate and sloppy mode
```

- Claude answers and fetched pages are cached on disk (`cardano/.cache/claude`, `cardano/.cache/pages/<agent>/`), so a rerun gives the same report and verdicts in seconds. `CLAUDE_CACHE=0` / `REFETCH=1` force fresh ones. A new topic (`-- --topic "…"`) takes about a minute of research on its first run.
- `--sloppy` reuses the same research, then simulates a careless write-up: claim #1 gets an altered quote, #2 the wrong source, #3 an overstated claim and #4 an invented quote. The fact-checker catches all four (three by code, the overstatement by Haiku), the report fails with HTTP 422.
- Each demo saves the full result (report, check table, tx hashes) to `cardano/.cache/checkedfacts/<task>.json`.
- Between runs the demo waits until the wallets have no transaction left in the mempool (a back-to-back run would otherwise reuse a spent input).

Ports: research agent 4120, fact-checker 4121, attack drill 4124–4125.

## 60-second demo script

Before going on stage: dashboard open at http://127.0.0.1:4000, `npm run prewarm -w apps/checkedfacts` done (so research is cached), two terminals in `cardano/`.

| Time | Say | Show / run |
|---|---|---|
| 0–10 s | "Maria runs a coffee shop in Munich. She wants a competitor report, but AI research makes things up. With CheckedFacts she only pays if every claim survives an independent fact-check." | Dashboard: three agents online with their Cardano addresses. |
| 10–30 s | "She pays 3 tUSDM over x402. The money is signed but held. Our research agent writes the report with sources and exact quotes, then hires a fact-checker agent and pays it per claim, on Cardano, through AgentGuard spending limits." | `npm run demo -w apps/checkedfacts`. Dashboard: held payment, two checker payments settling, ✔ per claim. |
| 30–40 s | "The checker opens every source itself. Code checks that the quote is really on the page; the AI only judges whether it supports the claim. 8 of 8 pass, so Maria's payment settles." | Terminal: report table, PASS. Click the cardanoscan link of the 3 tUSDM payment. |
| 40–55 s | "Now a sloppy researcher: wrong numbers, wrong sources. The checker catches it, the report fails, and Maria's signed payment is simply never submitted. She pays nothing. The researcher still paid for the checks: bad work costs the one who did it." | `npm run demo -w apps/checkedfacts -- --sloppy`. Dashboard: ✘ claims, "payment voided". |
| 55–60 s | "Pay only for checked facts. Agents hiring agents, with money tied to verified results, on Cardano." | Dashboard money-flow graph. |

Optional extra (10 s): `npm run attack -w apps/checkedfacts`: "A web page tells the agent to pay 2 tUSDM to an unknown address. Even if the AI falls for it, AgentGuard only pays the allowlisted checker, max 1 tUSDM a payment."

## Why Cardano judges should care

- **Payment tied to outcome**: x402 settle-only-on-success; the customer's transaction is signed up front and submitted only after the deterministic gate passes.
- **Agent hires agent**: the research agent buys checks from a separate agent with its own wallet, per batch, on preprod.
- **Safe agent wallets**: every agent payment goes through AgentGuard (payee allowlist, per-payment cap, per-task and daily budgets, audit log, kill switch).
- **Business model**: the research agent charges 3 tUSDM per report and spends 0.2 tUSDM per checked claim (8 claims: 1.6 tUSDM), so it earns only when its work is good.

## Files

| File | What |
|---|---|
| `demo.ts` | one command: three agents, customer order, prints report + tx links |
| `researcher.ts` | research agent: Sonnet research, self-check, buys checks, applies the gate, `--sloppy` mistakes |
| `checker.ts` | fact-checker agent: x402 service priced per claim; fetch, quote match, Haiku judgement |
| `verdict.ts` | the deterministic money rule (`gate`) |
| `pages.ts` | page fetching with disk cache, HTML to text, normalized quote matching |
| `attack.ts` | AgentGuard drill: prompt-injected payee and an overcharging look-alike, both blocked |
| `prewarm.ts` | research + checks without payments (fills caches before a live demo) |
| `chain.ts` | waits until a wallet has nothing in the mempool |

## Next steps

Masumi escrow instead of x402 (lock the customer's payment on chain, refund on timeout), a CIP-20 fact-check certificate per report, listing the checker on Sokosumi so any research agent can hire it.
