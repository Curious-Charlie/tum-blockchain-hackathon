# D5 ReproBounty: paid, verified paper reproduction with an on-chain certificate

A journal (or funder) pays an AI agent to reproduce a paper's numeric results. The agent buys compute from a second agent to run the authors' code and data, and pays a third agent to check its evidence. **The journal pays only for an attempt that passes verification, whatever the verdict.** The result is published as a reproduction certificate in Cardano transaction metadata, so anyone can look it up and check it.

Why: more than 70 % of researchers have tried and failed to reproduce someone else's experiment (Nature 2016 survey). Nobody pays for reproduction work and there is nowhere to publish a negative result. Journals already pay for this by hand: the AEA's data editor checks every replication package before an economics paper is published.

## How it works

```
Requester (journal) ── 5 tUSDM, x402, signed but held ──▶ Replicator agent
                                                          │ Claude Sonnet: target claims from the paper → numbers
                                                          │   code: keeps only numbers really printed in the paper
                                                          ├── 1 tUSDM ──▶ Compute agent: runs the pinned package
                                                          │                in a fresh temp dir, no env vars, 30 s timeout
                                                          │ Claude Haiku: which output column holds which claim
                                                          │   code: column exists; numeric comparison; verdict
                                                          │ evidence bundle: code/data/output/log hashes + comparison
                                                          ├── 1 tUSDM ──▶ Verifier agent: hashes, pinned code, an
                                                          │                independent re-run of the statistics step,
                                                          │                verdict follows from the numbers
                    verified ──▶ HTTP 200 ──▶ the 5 tUSDM settles ──▶ certificate on Cardano (CIP-20, label 674)
                    rejected ──▶ HTTP 422 ──▶ the signed payment is never submitted: the journal pays nothing
```

- **Pay for a verified attempt, not for the result you want.** A verified NOT REPRODUCED is paid and published exactly like a REPRODUCED; otherwise the agent would be paid to say "reproduced". Only an attempt that fails verification is unpaid, and then the Replicator eats its compute and verifier costs.
- **AI interprets, code decides.** Claude reads the paper and maps claims to output files. Hashes, the numeric comparison, the verdict and the verifier's pass/fail are plain deterministic code (`lib/compare.ts`, `agents/verifier.ts`).
- **Agents hire agents, per call, over x402 on Cardano preprod.** Every payment goes through AgentGuard (`@agentic/core`): payee allowlist with the real counterpart addresses, per-payment cap, task and daily budgets, audit log, kill switch.
- **The Replicator shops for compute.** It asks three compute agents for a price and picks one in code (`lib/market.ts`): within its AgentGuard budget, enough left for the Verifier, at least 80 % of past runs verified; cheapest wins. Every assessment goes to the dashboard. See [Buyer](#buyer-choosing-a-compute-agent).
- **Optional Masumi escrow for the bounty** (`--escrow`): the journal locks the 5 tUSDM in Masumi's escrow contract before any work starts, instead of x402 pay-on-success. See [Masumi escrow](#masumi-escrow---escrow).
- The Verifier is paid for the check whatever it finds, so it has no reason to wave a bundle through.

| Who | Pays | To | For | Guard policy |
|---|---|---|---|---|
| Requester (journal) | 5 tUSDM | Replicator | a verified reproduction | only the Replicator, ≤ 5 per payment and per task, ≤ 60 a day |
| Replicator | 0.5 / 1 / 3 tUSDM | one of three compute agents | one sandboxed run | only the compute agents and the Verifier, ≤ 1.5 per payment, ≤ 2.5 per task, ≤ 40 a day |
| Replicator | 1 tUSDM | Verifier | one evidence check | (same) |

Verdict rule (deterministic): a check passes if |computed − claimed| < one unit in the last printed digit. **REPRODUCED**: every check passes. **NOT REPRODUCED**: some claimed number is contradicted by every dataset it applies to. **PARTIAL**: otherwise.

## The demo paper

Matejka & Fitzmaurice, *Same Stats, Different Graphs*, CHI 2017 ([doi:10.1145/3025453.3025912](https://doi.org/10.1145/3025453.3025912)), the "Datasaurus Dozen". Figure 6 claims that 13 very different datasets share x̄ = 54.26, ȳ = 47.83, sd_x = 16.76, sd_y = 26.93 and r = −0.06 to two decimal places. Real, well known, public data, runs in 0.2 s with the Python standard library, so nothing can fail to install on stage. Data pinned to [jumpingrivers/datasauRus](https://github.com/jumpingrivers/datasauRus) @ `269706b9` (MIT). Provenance, licenses and hashes: [`papers/datasaurus/SOURCE.md`](papers/datasaurus/SOURCE.md).

Found on the way: the numbers only match if "two decimal places" means *truncation*: 65/65 values match truncated, only 20/65 rounded (sd_x is 16.7600–16.7700, which rounds to 16.77). The run reports this.

Three variants:

| Command | Story | Outcome |
|---|---|---|
| `npm run demo -w apps/reprobounty` | the real paper | REPRODUCED 65/65 → journal pays 5 tUSDM → certificate |
| `… -- --altered` | a manuscript with one wrong number (Fig. 6 says r = −0.60) | NOT REPRODUCED 52/65 → still verified, paid and published |
| `… -- --tamper` | a dishonest Replicator replaces its results with the paper's numbers and re-hashes the bundle | every hash lines up, but the Verifier's re-run does not → HTTP 422 → journal pays nothing |

## Buyer: choosing a compute agent

Three compute agents run the same pinned package; only their price and track record differ:

| Agent | Price | Track record | Decision |
|---|---|---|---|
| Budget compute agent | 0.5 tUSDM | 6/10 runs verified | rejected: below 80 % verified |
| Compute agent | 1 tUSDM | 41/42 runs verified | **chosen**: cheapest acceptable |
| Premium compute agent | 3 tUSDM | 50/50 runs verified | rejected: over AgentGuard's 1.5 tUSDM per-payment cap |

- The price is each agent's x402 402 answer to the real request, so it is exactly what it would charge.
- The track record is the Replicator's own ledger of runs it bought and how many passed the Verifier. **It starts from a made-up history** (`reputation.seed.json`) so the demo has agents with different records; every real run adds to it (`cardano/.cache/reputation.json`).
- The decision is code, not the LLM: the quote must pay the agent that was asked, fit the per-payment cap, leave enough of the task budget for the Verifier's fee, and come from an agent with at least 80 % verified over at least 5 runs. Then the cheapest wins. AgentGuard still enforces the caps on the payment itself.

## Masumi escrow (`--escrow`)

With x402 pay-on-success the Replicator holds the journal's signed payment while it works (see [Limitations](../../../docs/LIMITATIONS.md)). With `--escrow` the bounty goes through Masumi's escrow contract (`vested_pay`, payment V2) instead:

```
journal ── x402 (assetTransferMethod "masumi") ──▶ 5 tUSDM locked in Masumi escrow ── HTTP 202: job accepted
Replicator checks the lock against the terms it signed, then works (same pipeline, same payments to Compute and Verifier)
   verified ─▶ SubmitResult: result hash (= evidence bundle hash) into the escrow ─▶ certificate
              └─ from the unlock time (32 min after the quote) the Replicator collects; until then the journal could dispute
   failed   ─▶ AuthorizeRefund by the Replicator ─▶ the journal withdraws its 5 tUSDM at once
   vanished ─▶ (--vanish) nothing reaches the escrow ─▶ the journal withdraws from the submit-result deadline (17 min)
```

| Command | What happens |
|---|---|
| `npm run demo -w apps/reprobounty -- --escrow` | lock → work → result hash in the escrow → certificate (about 4 min) |
| `… -- --escrow --tamper` | lock → work fails verification → refund authorized → journal withdraws (about 4 min) |
| `… -- --escrow --vanish` | lock → the Replicator disappears |
| `npm run escrow -w apps/reprobounty` | status of every escrow job and its transactions |
| `npm run escrow -w apps/reprobounty -- finish --wait` | collects delivered jobs after their unlock time and refunds abandoned ones after their deadline |

The deadlines are the shortest Masumi's rules allow, so collecting takes at least about 32 minutes after the quote; on stage the lock is shown live and the collect and timeout-refund transactions are shown from earlier runs. Contract: [`contracts/`](contracts/) (Masumi's blueprint, MIT, checked against `@x402/cardano` by `test/escrow.test.ts`); transactions: `lib/escrow.ts`.

## Run

```sh
cd cardano
npm install                                  # once
npm run dashboard                            # terminal 1: http://127.0.0.1:4000 (keep open)
npm run wallets -w apps/reprobounty          # terminal 2: show the 4 role wallets and balances
npm run demo -w apps/reprobounty             # happy path, about 2 minutes (two block confirmations)
npm run demo -w apps/reprobounty -- --altered
npm run demo -w apps/reprobounty -- --tamper
npm run demo -w apps/reprobounty -- --escrow  # the bounty through Masumi escrow (see above)
npm run escrow -w apps/reprobounty -- finish --wait   # collect / refund escrow jobs when due
npm run check -w apps/reprobounty -- <certificate tx hash>   # anyone: read the certificate from chain, re-verify the evidence
npm run rehearse -w apps/reprobounty         # same pipeline offline: no wallets, no payments
npm test -w apps/reprobounty                 # deterministic pipeline tests (no Claude, no chain)
```

Needs `cardano/.env` (`BLOCKFROST_PROJECT_ID`, `ANTHROPIC_API_KEY`) and `apps/reprobounty/.env` with `REQUESTER_MNEMONIC`, `REPLICATOR_MNEMONIC`, `COMPUTE_MNEMONIC`, `COMPUTE_B_MNEMONIC`, `COMPUTE_C_MNEMONIC`, `VERIFIER_MNEMONIC` (`npm run wallets -w apps/reprobounty` creates missing ones). Requester and Replicator need tADA + tUSDM (Masumi dispenser); the compute agents and the Verifier only receive. Ports 4151–4155. Each run costs the Requester 5 tUSDM + ~1.3 tADA and the Replicator ~2.6 tADA in fees and min-UTxO deposits. Claude answers are cached on disk, so reruns cost nothing; a cold run costs about $0.01.

`--no-wait` skips waiting for the certificate's block (saves ~30 s). Evidence bundles of runs are written to `evidence/<bundle hash>.json`.

## 60-second demo script

Before: dashboard open and cleared; terminal in `cardano/`; one run done today (warm cache); tabs open on an earlier escrow **collect** and **timeout refund** transaction (see [Preprod runs](#preprod-runs-2026-10-30)), since those only become possible 17–32 minutes after a lock.

| Time | Say | Show / do |
|---|---|---|
| 0:00 | "70 % of researchers have failed to reproduce someone else's result, and nobody pays for reproduction. ReproBounty lets a journal pay AI agents to reproduce a paper, and pay only for verified work." | Start `npm run demo -w apps/reprobounty -- --escrow --no-wait`. Dashboard: six agents appear. |
| 0:10 | "**Coworker**: the journal's 5 tUSDM go into Masumi's escrow contract on Cardano before any work starts. Nobody holds an unsettled IOU." | Requester → Masumi escrow edge turns green; open the lock tx. |
| 0:20 | "**Buyer**: the Replicator needs compute. It asks three agents for a price and decides in code: the cheap one fails too often, the premium one is over its AgentGuard budget. It hires the middle one." | Timeline: the three ✓/✗ lines and "Buyer decision". |
| 0:30 | "**Seller**: every agent sells over x402. Compute runs the published code and data, plain code compares 65 numbers, Claude never decides the verdict. A third agent is paid to verify the evidence." | Replicator → Compute and → Verifier edges with tx links. |
| 0:45 | "Verified, so the result hash goes into the escrow and the certificate onto Cardano. After the dispute window the Replicator collects; if the work had failed, it refunds the journal; if it had vanished, the journal takes the money back after the deadline." | The certificate tx (Metadata tab), then the prepared collect and refund tabs. |
| 0:55 | "Agents that sell, buy carefully, and work together, with money tied to verified results." | Dashboard money-flow graph. |

Without escrow (`npm run demo -w apps/reprobounty`) the same flow settles in one x402 request, about 2–3 minutes; `-- --tamper` shows the journal paying nothing.

## Preprod runs (2026-10-30)

| Run | Step | Transaction |
|---|---|---|
| real paper → REPRODUCED 65/65 (final code) | Replicator → Compute 1 tUSDM | [6b1bfcfc…](https://preprod.cardanoscan.io/transaction/6b1bfcfcccd2c9200dcfc6d6f283e4cbb5d47eabc2d15cf724e1314005afb8cd) |
| | Replicator → Verifier 1 tUSDM | [b891d9ed…](https://preprod.cardanoscan.io/transaction/b891d9edc1ed56c469a1b4b252af35d14fc51105945c71d8f51f0e20549a0b2a) |
| | Requester → Replicator 5 tUSDM (bounty) | [a4b5a81d…](https://preprod.cardanoscan.io/transaction/a4b5a81d37d2e52bcba52f34e060aa06a8e60c52dd780379feec0425718dc56f) |
| | certificate (CIP-20) | [80f0deef…](https://preprod.cardanoscan.io/transaction/80f0deef03da8ea44cfac8f15443102dd4690b26fa618810384f696338755f23) |
| real paper, first run | bounty / certificate | [c84d1ea9…](https://preprod.cardanoscan.io/transaction/c84d1ea930b4f444d62ac46e4a9d886f7594deba38287572c75e86aea5ae0fa6) / [4e1bb6cd…](https://preprod.cardanoscan.io/transaction/4e1bb6cd294158d5e119bb7a0efc17532038dc91b3d1c70d54b229dc0b5dd779) |
| `--altered` → NOT REPRODUCED 52/65 | Replicator → Compute 1 tUSDM | [6151bb0e…](https://preprod.cardanoscan.io/transaction/6151bb0e2df0ee1581cd6d7e6eb40b165e384625ddaf39b067d4def31f0db4b4) |
| | Replicator → Verifier 1 tUSDM | [e270c185…](https://preprod.cardanoscan.io/transaction/e270c1850141db1035a2207bb118df0223d08fb79de718729ef5e8b32413649f) |
| | Requester → Replicator 5 tUSDM (bounty) | [8ee8aaaf…](https://preprod.cardanoscan.io/transaction/8ee8aaafb0b13a723eeb01d55ed15d3da4f8d6d7f2a7c8af82369299b5537a61) |
| | certificate (CIP-20) | [38b977f7…](https://preprod.cardanoscan.io/transaction/38b977f7a475babc66fc8f01ac1e505de6f474cbc43122ab61e0c56b7fc161b2) |
| `--tamper` → verifier rejects the re-run | Replicator → Compute 1 tUSDM | [1dbf700d…](https://preprod.cardanoscan.io/transaction/1dbf700d968508241f5a4ea7ebbc8cdbcd5c0c6fd10094fb28dc10ad9527f906) |
| | Replicator → Verifier 1 tUSDM (paid for the check) | [6b4504bf…](https://preprod.cardanoscan.io/transaction/6b4504bf4bd1b4729e3f9c2724e582bf2603595ec07e0879d138198c668346e3) |
| | Requester → Replicator 5 tUSDM | HTTP 422: signed but never submitted, no transaction (Requester balance unchanged) |

Check a certificate yourself: `npm run check -w apps/reprobounty -- 80f0deef03da8ea44cfac8f15443102dd4690b26fa618810384f696338755f23`.

## Files

| Path | What |
|---|---|
| `demo.ts` | one command: starts the four agents and posts the bounty |
| `agents/replicator.ts` | paid `POST /reproduce`; Claude extraction and mapping; pays Compute and Verifier; publishes the certificate |
| `agents/compute.ts` | paid `POST /run`; allowlisted, hash-pinned packages only (three instances at different prices) |
| `agents/verifier.ts` | paid `POST /verify`; deterministic checks |
| `lib/compare.ts` | claim validation, numeric comparison, verdict |
| `lib/market.ts`, `lib/reputation.ts`, `reputation.seed.json` | the Replicator's quotes, track records and buying decision |
| `lib/escrow.ts`, `escrow.ts`, `contracts/` | Masumi escrow: SubmitResult, Withdraw, AuthorizeRefund, WithdrawRefund; the collect/refund command; the vendored contract |
| `lib/evidence.ts`, `lib/stats.ts` | hashing and bundle format; the verifier's independent statistics |
| `registry.ts`, `papers/` | the demo paper, its altered copy, the pinned replication package |
| `check.ts`, `rehearse.ts`, `test/` | public certificate check, offline rehearsal, tests |

## Limits and roadmap

- Code runs in a temp dir with an empty environment and a timeout, and only for packages on the Compute agent's allowlist. A container sandbox (no network, CPU and memory limits) is roadmap.
- The verifier's re-run is specific to this package's statistics step. Next: the verifier buys its own run from a second compute provider.
- Evidence bundles live in `evidence/`; the certificate commits to their hash. Next: content-addressed storage (IPFS).
- Masumi escrow is implemented for the bounty (`--escrow`); x402 stays the default because it settles in one request. Disputes (the journal's `SetRefundRequested`) are not wired up. Next: a Sokosumi listing for the Replicator.
- The compute agents' track records start from a made-up seed. Next: derive them from the certificates on chain.
