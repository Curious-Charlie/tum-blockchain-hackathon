# D2 CheckedFacts: research you only pay for if it passes a fact-check

A shop owner buys a competitor report from an AI research agent over x402 on Cardano. Before delivering, the research agent **hires and pays a second agent, a fact-checker**, which opens every cited page, checks in code that each quote is really there, and has Claude Haiku judge whether the quote supports the claim. **The shop owner's payment only settles if the report passes**; otherwise the signed payment is never submitted and the shop owner pays nothing. The fact-checker publishes its verdict on Cardano as a CIP-20 certificate. Bad research is the research agent's loss: it has already paid for the checks.

Design: `docs/DESIGN.md` §4 (D2). Shared infrastructure: `packages/core`.

```
Shop owner ──3 tUSDM, held──▶ Research agent ──0.2 tUSDM per claim──▶ Fact-checker agent ──▶ CIP-20 certificate
 (CUSTOMER)   settles only     (RESEARCHER)     x402 through AgentGuard  (CHECKER)              on Cardano
              if checks pass   Sonnet + web                              fetches sources,
                               search                                    quote match in code,
                                                                         Haiku judges support
```

## The money rule (deterministic, `verdict.ts`)

AI interprets, code decides. For each claim the checker returns one of:

| Verdict | Decided by |
|---|---|
| `quote_not_found` | **code**: the source page was fetched, but the quote is not on it (normalized exact match: case, punctuation and typographic quotes are ignored; a quote under 6 words fails) |
| `unverifiable` | **code**: the source could not be fetched (network error, HTTP error, bot wall, PDF, almost no text) |
| `supported` / `unsupported` | **Haiku**, only after code has proven that the quote is on the page: does the quote, in its page context, support the claim? |

Then `gate()` decides whether the shop owner pays:

- `checkable` = claims that are not `unverifiable`; `pass rate` = `supported / checkable`
- **settle ⇔ checkable ≥ 5 and pass rate ≥ 85%** (with 8 claims: at most one miss)
- An unverifiable claim counts as neither fabricated nor supported: a dead or bot-blocked source is not the researcher's lie. But the report must still have at least 5 checkable claims, so nobody can pass by citing pages that cannot be opened.

Before paying for checks, the research agent self-checks its quotes (the same deterministic match on its own copy of each page) and drops the failures. The customer does not have to trust that step: the paid, independent check is what gates the money.

**Trust model.** The fact-checker applies the same `gate()` to everything it checked and publishes the result on Cardano (label 674): the verdict, one letter per claim, and the sha256 of the exact claims it checked. `npm run verify` is the shop owner's own audit. It reads the certificate from the chain and checks that it was published by the checker's wallet, that it is about this order, and that the hash matches the claims received. A research agent that delivered a report its checker had failed would be caught publicly. (Upgrade path: Masumi escrow, so that the checker's attestation itself releases the money.)

## Setup and run

```sh
cd cardano
npm run dashboard                                  # terminal 1, http://127.0.0.1:4000 (skip if it is already running)
npm run wallets -w apps/checkedfacts               # balances; CUSTOMER and RESEARCHER need tADA + tUSDM

npm run prewarm -w apps/checkedfacts               # research + checks WITHOUT payments (fills the caches, ≈45 s the first time)
npm run demo -w apps/checkedfacts -- --fast        # happy path, one checker payment (≈1 min)
npm run demo -w apps/checkedfacts -- --sloppy --fast   # failure path: report fails, the shop owner pays nothing (≈1 min)
npm run demo -w apps/checkedfacts                  # happy path, checker paid in two batches (≈2 min: one block confirmation in between)
npm run verify -w apps/checkedfacts                # shop owner audits the latest run's certificate on chain
npm run attack -w apps/checkedfacts                # AgentGuard blocks a prompt-injected payment (no chain, ≈5 s)
npm test -w apps/checkedfacts                      # quote matching, the gate, sloppy mode, certificate format
```

- Claude answers and fetched pages are cached on disk (`cardano/.cache/claude`, `cardano/.cache/pages/<agent>/`), so a rerun gives the same report and verdicts within seconds. `CLAUDE_CACHE=0` / `REFETCH=1` force fresh ones. A new topic (`-- --topic "…"`) takes about 40 s of research on its first run.
- `--sloppy` reuses the same research, then simulates a careless write-up: claim #1 gets an altered quote, #2 the wrong source, #3 an overstated claim and #4 an invented quote. The fact-checker catches all four (three by code, the overstatement by Haiku), and the report fails with HTTP 422.
- `--fast` sends all claims to the checker in one paid request (max 8) instead of batches of 4. That means no confirmation wait inside the order, which makes it the safer choice on stage.
- Each run saves the full result (report, check table, tx hashes) to `cardano/.cache/checkedfacts/<task>.json`.
- **Demo from another checkout** (for example `main` after a merge): the caches live in that checkout's `cardano/.cache/`. Either run `npm run prewarm -w apps/checkedfacts` there once, or copy `cardano/.cache/claude` and `cardano/.cache/pages` across from this worktree. Without the cache the research runs fresh: about 40 s and about $0.10, and Sonnet writes a different (but still checked) report.

Ports: research agent 4120, fact-checker 4121, attack drill 4124–4125.

## 60-second demo script

Before going on stage: dashboard open at http://127.0.0.1:4000, `prewarm` done in the checkout you demo from, and one terminal in `cardano/`. Start the first command while you speak the first line: it takes about a minute.

| Time | Say | Show / run |
|---|---|---|
| 0–10 s | "Maria runs a coffee shop in Munich. She wants a report on her competitors, but AI research makes things up. With CheckedFacts she only pays if every claim survives an independent fact-check." | `npm run demo -w apps/checkedfacts -- --fast`. Dashboard: three agents come online with their Cardano addresses. |
| 10–30 s | "She pays 3 tUSDM over x402. The payment is signed but held. Our research agent writes the report with sources and exact quotes, then hires a fact-checker agent and pays it per claim, on Cardano, through AgentGuard spending limits." | Dashboard: held payment, checker payment settling, ✔ for each claim. |
| 30–40 s | "The checker opens every source itself. Code checks that each quote is really on the page; the AI only judges whether it supports the claim. 8 of 8 pass: Maria's payment settles, and the checker publishes its verdict on chain." | Terminal: report table, PASS. Click the 3 tUSDM payment link and the certificate (Metadata tab). |
| 40–55 s | "Now a sloppy researcher: a changed number, a wrong source, an exaggeration, an invented quote. The checker catches all four, the report fails, and Maria's signed payment is never submitted. She pays nothing. The researcher still paid for the checks: bad work costs whoever did it." | `npm run demo -w apps/checkedfacts -- --sloppy --fast` (started at 35 s). Dashboard: ✘ claims, "never submitted, nothing paid". |
| 55–60 s | "Pay only for checked facts: agents hiring agents, with money tied to verified results, on Cardano." | Dashboard money-flow graph. |

Optional extras: `npm run attack -w apps/checkedfacts` (10 s): "A web page tells the agent to pay 2 tUSDM to an unknown address. Even if the AI falls for it, AgentGuard only pays the allowlisted checker, at most 1.6 tUSDM a payment." `npm run verify -w apps/checkedfacts`: "Maria's own agent checks the certificate on Cardano against the report she got."

## Real runs on preprod (2026-10-30)

Happy path (`--fast`), 8/8 supported, PASS:
- research agent → fact-checker 1.6 tUSDM: [14215a1b…](https://preprod.cardanoscan.io/transaction/14215a1b0d22ae4d152e7d9b3b651e5785f11d3b23c9d8f7dc0e45bc008e074d)
- fact-check certificate (CIP-20): [76e54008…](https://preprod.cardanoscan.io/transaction/76e5400833bdabeb6816d62647dcf86ecdf8ba9332c94eec5e9b53f49ec27e5e)
- shop owner → research agent 3 tUSDM: [a43ea137…](https://preprod.cardanoscan.io/transaction/a43ea13729ca28d5ba0cba74699cb2f7cfc8aacaf6ce24466251d8172babdc76)

Failure path (`--sloppy --fast`), 4/8 supported, FAIL, HTTP 422, the shop owner's signed 3 tUSDM was never submitted:
- research agent → fact-checker 1.6 tUSDM: [b9b7e584…](https://preprod.cardanoscan.io/transaction/b9b7e5845ed0210614e819d6e47f5cb4b174ad6eaf4bebd2e60594685559f2f8)
- fact-check certificate (FAIL): [b81428cf…](https://preprod.cardanoscan.io/transaction/b81428cf1b70b3f556c65a5ec2ac60f047308e385f7fe7fd139808477ddb5b39)

## Why Cardano judges should care

- **Payment tied to outcome**: x402 settle-only-on-success. The customer's transaction is signed up front and submitted only after the deterministic gate passes.
- **Agent hires agent**: the research agent buys checks from a separate agent with its own wallet, on preprod, priced per claim.
- **Published on chain**: every verdict, pass or fail, becomes a public CIP-20 certificate signed by the checker's wallet, so research agents build (or lose) a track record.
- **Safe agent wallets**: every agent payment goes through AgentGuard (payee allowlist, per-payment cap, per-task and daily budgets, audit log, kill switch).
- **Business model**: the research agent charges 3 tUSDM per report and spends 0.2 tUSDM per checked claim (8 claims cost 1.6 tUSDM), so it earns only when its work is good; the checker earns on every check.

## Files

| File | What |
|---|---|
| `demo.ts` | one command: three agents, the customer's order, prints the report and tx links |
| `researcher.ts` | research agent: Sonnet research, self-check, buys checks, applies the gate, `--sloppy` mistakes |
| `checker.ts` | fact-checker agent: x402 service priced per claim (fetch, quote match, Haiku judgement), publishes certificates |
| `verdict.ts` | the deterministic money rule (`gate`), claims hash |
| `pages.ts` | page fetching with disk cache, HTML to text, normalized quote matching |
| `verify.ts` | shop owner's audit of a certificate against the report it received |
| `attack.ts` | AgentGuard drill: prompt-injected payee and an overcharging look-alike, both blocked |
| `prewarm.ts` | research + checks without payments (fills the caches before a live demo) |

## Next steps

Masumi escrow instead of plain x402 (lock the customer's payment on chain; the checker's certificate releases it, a timeout refunds it), and listing the fact-checker on Sokosumi so that any research agent can hire it.
