# ReproBounty: paid, verified paper reproduction on Cardano

> Submission for the [TUM Blockchain & AI Hackathon 2026](https://hackathon.tum-blockchain.com/) (Munich, 30–31 October 2026). **Track:** Cardano — Agentic Commerce on Cardano.

**Demo video:** TBD

A journal pays an AI agent to reproduce a paper's numeric results. The agent buys compute from a second agent to run the authors' code and data, and pays a third agent to check its evidence. **The journal pays only for an attempt that passes verification, whatever the verdict**, and the result is published as a reproduction certificate on Cardano that anyone can look up and re-check.

## The problem

More than 70 % of researchers have tried and failed to reproduce someone else's experiment (Nature, 2016 survey). Reproduction work is rarely paid and negative results have nowhere to go. Some journals already pay for it by hand: the American Economic Association's data editor checks every replication package before a paper is published. ReproBounty turns that check into a paid, verifiable agent service.

## What it does

```
Requester (journal) ── 5 tUSDM, x402, signed but held ──▶ Replicator agent
                                                          │ Claude reads the paper: target claims → numbers
                                                          ├── 1 tUSDM ──▶ Compute agent: runs the pinned code and data
                                                          │ deterministic code compares 65 numbers → verdict
                                                          ├── 1 tUSDM ──▶ Verifier agent: hashes + an independent re-run
                     verified ──▶ HTTP 200 ──▶ the 5 tUSDM settles ──▶ certificate on Cardano (CIP-20 metadata)
                     rejected ──▶ HTTP 422 ──▶ the signed payment is never submitted: the journal pays nothing
```

- **Pay for a verified attempt, not for the result you want.** A verified NOT REPRODUCED is paid and published exactly like a REPRODUCED, so the agent gains nothing by faking success. Only an attempt that fails verification is unpaid.
- **AI interprets, code decides.** Claude extracts the claims from the paper and maps output columns to them. Hashes, the numeric comparison, the verdict and the Verifier's pass or fail are deterministic code.
- **Agents hire agents, per call, on Cardano.** Every agent sells its work over x402 and pays through **AgentGuard**: an allowlist of payees, per-payment caps, task and daily budgets, an audit log and a kill switch, so an agent with a wallet cannot overspend or be talked into paying someone else.
- **Published on chain.** The certificate (DOI, claim, verdict, evidence hash, verifier, bounty transaction) is CIP-20 transaction metadata. `npm run check -- <tx>` reads it back from the chain and re-verifies the evidence.

The demo paper is *Same Stats, Different Graphs* (Matejka & Fitzmaurice, CHI 2017, the "Datasaurus Dozen"): 13 datasets that share the same summary statistics. Details, the three demo variants and a 60-second demo script: [`cardano/apps/reprobounty/README.md`](cardano/apps/reprobounty/README.md).

## Cardano tools used

- **x402 on Cardano preprod** (`@x402/cardano`, `@x402/express`, `@x402/fetch`) with an in-process facilitator: every agent-to-agent payment is a paid HTTP request; a handler that fails (status ≥ 400) means the buyer's signed transaction is never submitted.
- **tUSDM** (Masumi's preprod stablecoin) for all prices; tADA for fees.
- **CIP-20 transaction metadata** (label 674) for the reproduction certificate.
- **Blockfrost** for chain access, **evolution-sdk** to build transactions.

## Setup and run

Requires Node.js 22+, a free [Blockfrost](https://blockfrost.io) preprod project id and an [Anthropic API key](https://console.anthropic.com).

```sh
git clone https://github.com/Curious-Charlie/tum-blockchain-hackathon.git
cd tum-blockchain-hackathon/cardano
npm install
cp .env.example .env                        # fill in BLOCKFROST_PROJECT_ID and ANTHROPIC_API_KEY
npm run wallets -w apps/reprobounty         # creates the 4 agent wallets in apps/reprobounty/.env, prints their addresses
```

Fund the **Requester** and **Replicator** addresses at the [Masumi dispenser](https://dispenser.masumi.network) (network Testnet, paste the address, Claim Tokens: 100 tADA + 100 tUSDM each). Compute and Verifier only receive. Then:

```sh
npm run dashboard                           # terminal 1: live dashboard on http://127.0.0.1:4000
npm run demo -w apps/reprobounty            # terminal 2: the real paper, about 2–3 minutes
npm run demo -w apps/reprobounty -- --altered   # one wrong number in the paper: NOT REPRODUCED, still paid and published
npm run demo -w apps/reprobounty -- --tamper    # the Replicator fakes its results: verification fails, the journal pays nothing
npm run check -w apps/reprobounty -- <certificate tx hash>   # anyone: read a certificate from chain and re-verify it
```

`npm run rehearse -w apps/reprobounty` runs the same pipeline offline (no wallets, no payments); `npm test` and `npm test -w apps/reprobounty` run the tests. Claude answers are cached on disk, so reruns cost nothing.

## Evidence on Cardano preprod

| Run | Transaction |
|---|---|
| Journal pays the 5 tUSDM bounty (verified REPRODUCED, 65/65) | [a4b5a81d…](https://preprod.cardanoscan.io/transaction/a4b5a81d37d2e52bcba52f34e060aa06a8e60c52dd780379feec0425718dc56f) |
| Reproduction certificate for that run (CIP-20, see the Metadata tab) | [80f0deef…](https://preprod.cardanoscan.io/transaction/80f0deef03da8ea44cfac8f15443102dd4690b26fa618810384f696338755f23) |
| Replicator hires the Compute agent (1 tUSDM) | [6b1bfcfc…](https://preprod.cardanoscan.io/transaction/6b1bfcfcccd2c9200dcfc6d6f283e4cbb5d47eabc2d15cf724e1314005afb8cd) |
| Replicator hires the Verifier agent (1 tUSDM) | [b891d9ed…](https://preprod.cardanoscan.io/transaction/b891d9edc1ed56c469a1b4b252af35d14fc51105945c71d8f51f0e20549a0b2a) |
| `--altered`: NOT REPRODUCED (52/65), still paid and published | [38b977f7…](https://preprod.cardanoscan.io/transaction/38b977f7a475babc66fc8f01ac1e505de6f474cbc43122ab61e0c56b7fc161b2) |
| `--tamper`: verification fails, HTTP 422 | no bounty transaction: the journal's signed payment was never submitted |

More runs are listed in the [app README](cardano/apps/reprobounty/README.md#preprod-runs-2026-10-30).

## Honest limitations

With x402 the Replicator holds the journal's signed payment while it works: the signature is valid for about 10 minutes and the journal could double-spend before settlement. The upgrade path is Masumi escrow. Full list: [docs/LIMITATIONS.md](docs/LIMITATIONS.md) ([中文](docs/LIMITATIONS.zh.md)).

## Repository layout

| Path | What it is |
|---|---|
| [`cardano/apps/reprobounty/`](cardano/apps/reprobounty/) | ReproBounty: the four agents, the demo paper and its pinned replication package |
| [`cardano/packages/core/`](cardano/packages/core/) | Shared infrastructure: role wallets, x402 seller kit, AgentGuard, CIP-20 publishing, Claude helpers, live dashboard |
| [`cardano/scripts/`](cardano/scripts/) | `smoke-x402.ts` (one paid request) and `publish-test.ts` (one CIP-20 record) |
| [`docs/`](docs/) | Limitations, design notes and track rules |

## Team

CURIOUSCHARLIE (solo), built with Claude Code.
