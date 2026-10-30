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
- The Verifier is paid for the check whatever it finds, so it has no reason to wave a bundle through.

| Who | Pays | To | For | Guard policy |
|---|---|---|---|---|
| Requester (journal) | 5 tUSDM | Replicator | a verified reproduction | only the Replicator, ≤ 5 per payment and per task, ≤ 60 a day |
| Replicator | 1 tUSDM | Compute | one sandboxed run | only Compute and Verifier, ≤ 1.5 per payment, ≤ 2.5 per task, ≤ 40 a day |
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

## Run

```sh
cd cardano
npm install                                  # once
npm run dashboard                            # terminal 1: http://127.0.0.1:4000 (keep open)
npm run wallets -w apps/reprobounty          # terminal 2: show the 4 role wallets and balances
npm run demo -w apps/reprobounty             # happy path, about 2 minutes (two block confirmations)
npm run demo -w apps/reprobounty -- --altered
npm run demo -w apps/reprobounty -- --tamper
npm run check -w apps/reprobounty -- <certificate tx hash>   # anyone: read the certificate from chain, re-verify the evidence
npm run rehearse -w apps/reprobounty         # same pipeline offline: no wallets, no payments
npm test -w apps/reprobounty                 # deterministic pipeline tests (no Claude, no chain)
```

Needs `cardano/.env` (`BLOCKFROST_PROJECT_ID`, `ANTHROPIC_API_KEY`) and `apps/reprobounty/.env` with `REQUESTER_MNEMONIC`, `REPLICATOR_MNEMONIC`, `COMPUTE_MNEMONIC`, `VERIFIER_MNEMONIC` (`npm run wallets -w apps/reprobounty` creates missing ones). Requester and Replicator need tADA + tUSDM (Masumi dispenser); Compute and Verifier only receive. Ports 4151–4153. Each run costs the Requester 5 tUSDM + ~1.3 tADA and the Replicator ~2.6 tADA in fees and min-UTxO deposits. Claude answers are cached on disk, so reruns cost nothing; a cold run costs about $0.01.

`--no-wait` skips waiting for the certificate's block (saves ~30 s). Evidence bundles of runs are written to `evidence/<bundle hash>.json`.

## 60-second demo script

Before: dashboard open in the browser and cleared; terminal in `cardano/`; one happy-path run done today (warm cache, known-good wallets). Have the cardanoscan link of the last certificate in a tab as a fallback.

| Time | Say | Show / do |
|---|---|---|
| 0:00 | "70 % of researchers have failed to reproduce someone else's result, and nobody pays for reproduction. ReproBounty lets a journal pay an AI agent to reproduce a paper, and pay only if the work is verified." | Start `npm run demo -w apps/reprobounty -- --no-wait`. Dashboard: four agents appear. |
| 0:10 | "The journal offers 5 tUSDM through x402. The payment is signed but held." | Dashboard: Requester → Replicator edge "pending 5 tUSDM". |
| 0:15 | "Claude reads the Datasaurus paper and turns Figure 6 into five numbers. Then the agent hires a compute agent, 1 tUSDM, to run the published data in a sandbox." | Timeline: the 5 claims; Replicator → Compute turns green with a tx link. |
| 0:25 | "Plain code compares 65 numbers. Claude never decides the verdict. It also finds the paper truncates rather than rounds." | Timeline: "65/65 checks pass → REPRODUCED", the truncation note. |
| 0:35 | "A third agent, the verifier, is paid to check the evidence: hashes, the pinned code, and its own re-run." | Replicator → Verifier edge, the verifier's ✓ lines. |
| 0:45 | "Verified, so the journal's payment settles and the certificate goes on Cardano. A failed reproduction is paid and published too; a faked one is not. With `--tamper`, the agent fakes its numbers and the journal pays nothing." | Requester → Replicator turns green; open the certificate tx → Metadata tab (or the fallback tab). |
| 0:55 | "Agents hiring agents, money tied to verified work, results published on chain." | Dashboard money-flow graph. |

For a longer slot, run `-- --tamper` next (about 40 s): the dashboard shows the voided 5 tUSDM edge and the verifier's ✗ re-run line.

## Preprod runs (2026-10-30)

| Run | Step | Transaction |
|---|---|---|
| real paper → REPRODUCED 65/65 | Replicator → Compute 1 tUSDM | [907c4883…](https://preprod.cardanoscan.io/transaction/907c48830290e723587de6afa79a86d3d4365b7041806c133b104cb2c45b9e4f) |
| | Replicator → Verifier 1 tUSDM | [1025c84f…](https://preprod.cardanoscan.io/transaction/1025c84f371cdd23e7ed8f64201ed3ba17b62dc4022aa6bc4adfe9e795fdd060) |
| | Requester → Replicator 5 tUSDM (bounty) | [c84d1ea9…](https://preprod.cardanoscan.io/transaction/c84d1ea930b4f444d62ac46e4a9d886f7594deba38287572c75e86aea5ae0fa6) |
| | certificate (CIP-20) | [4e1bb6cd…](https://preprod.cardanoscan.io/transaction/4e1bb6cd294158d5e119bb7a0efc17532038dc91b3d1c70d54b229dc0b5dd779) |
| `--altered` → NOT REPRODUCED 52/65 | Replicator → Compute 1 tUSDM | [6151bb0e…](https://preprod.cardanoscan.io/transaction/6151bb0e2df0ee1581cd6d7e6eb40b165e384625ddaf39b067d4def31f0db4b4) |
| | Replicator → Verifier 1 tUSDM | [e270c185…](https://preprod.cardanoscan.io/transaction/e270c1850141db1035a2207bb118df0223d08fb79de718729ef5e8b32413649f) |
| | Requester → Replicator 5 tUSDM (bounty) | [8ee8aaaf…](https://preprod.cardanoscan.io/transaction/8ee8aaafb0b13a723eeb01d55ed15d3da4f8d6d7f2a7c8af82369299b5537a61) |
| | certificate (CIP-20) | [38b977f7…](https://preprod.cardanoscan.io/transaction/38b977f7a475babc66fc8f01ac1e505de6f474cbc43122ab61e0c56b7fc161b2) |
| `--tamper` → verifier rejects the re-run | Replicator → Compute 1 tUSDM | [1dbf700d…](https://preprod.cardanoscan.io/transaction/1dbf700d968508241f5a4ea7ebbc8cdbcd5c0c6fd10094fb28dc10ad9527f906) |
| | Replicator → Verifier 1 tUSDM (paid for the check) | [6b4504bf…](https://preprod.cardanoscan.io/transaction/6b4504bf4bd1b4729e3f9c2724e582bf2603595ec07e0879d138198c668346e3) |
| | Requester → Replicator 5 tUSDM | HTTP 422: signed but never submitted, no transaction (Requester balance unchanged) |

Check a certificate yourself: `npm run check -w apps/reprobounty -- 4e1bb6cd294158d5e119bb7a0efc17532038dc91b3d1c70d54b229dc0b5dd779`.

## Files

| Path | What |
|---|---|
| `demo.ts` | one command: starts the four agents and posts the bounty |
| `agents/replicator.ts` | paid `POST /reproduce`; Claude extraction and mapping; pays Compute and Verifier; publishes the certificate |
| `agents/compute.ts` | paid `POST /run`; allowlisted, hash-pinned packages only |
| `agents/verifier.ts` | paid `POST /verify`; deterministic checks |
| `lib/compare.ts` | claim validation, numeric comparison, verdict |
| `lib/evidence.ts`, `lib/stats.ts` | hashing and bundle format; the verifier's independent statistics |
| `registry.ts`, `papers/` | the demo paper, its altered copy, the pinned replication package |
| `check.ts`, `rehearse.ts`, `test/` | public certificate check, offline rehearsal, tests |

## Limits and roadmap

- Code runs in a temp dir with an empty environment and a timeout, and only for packages on the Compute agent's allowlist. A container sandbox (no network, CPU and memory limits) is roadmap.
- The verifier's re-run is specific to this package's statistics step. Next: the verifier buys its own run from a second compute provider.
- Evidence bundles live in `evidence/`; the certificate commits to their hash. Next: content-addressed storage (IPFS).
- Upgrade path: Masumi escrow instead of x402 hold-and-settle, and a Sokosumi listing for the Replicator.
