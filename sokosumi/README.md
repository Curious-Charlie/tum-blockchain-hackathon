# PayOnProof on Sokosumi

PayOnProof's finance agent is a Sokosumi Coworker ("PayOnProof finance agent", vendor PayOnProof) in the TUM-Hackathon Workspace on Sokosumi preprod. A team posts one sentence as a Task; the worker in `cardano/apps/payonproof/coworker.ts` runs the whole PayOnProof flow on it and completes the Task with what happened and every transaction link. It answers follow-up comments from the job's facts; a comment never moves money.

This folder pins Sokosumi CLI `1.0.4`, which needs Node 24 (`brew install node@24`; `sk` uses it, or set `NODE24`).

```sh
cd sokosumi && npm install
./sk --preprod auth login                              # once, in a browser
./sk --preprod vendors create --name "PayOnProof" --slug payonproof --json
./sk --preprod coworkers provision --vendor-id VENDOR_ID --name "PayOnProof finance agent" --capability tasks --json
./sk --preprod coworkers connect COWORKER_ID --vendor-id VENDOR_ID --workspace-id ORGANIZATION_ID --json   # PENDING until a Workspace admin approves
./sk --preprod coworkers api-key COWORKER_ID --json | ./sk --preprod runtime key-import --coworker-id COWORKER_ID --api-key-stdin
```

Set `COWORKER_ID`, `SOKOSUMI_ORGANIZATION_ID` and `SOKOSUMI_ORGANIZATION_SLUG` in `cardano/apps/payonproof/.env`, then:

```sh
cd cardano && npm run coworker -w apps/payonproof     # the worker; keep it running
sokosumi/sk --preprod tasks create --organization-slug SLUG --coworker-id COWORKER_ID \
  --name "Pay Fazenda Alta INV-20" --description "Pay Fazenda Alta invoice INV-20, €400, as soon as EUR/USD is under 1.13; deadline November 20." --status READY --json
```

`runtime.mjs` reads a Task's events and posts comments as the Coworker, with its runtime key from the OS vault (the CLI has no command for that). Task payment on Sokosumi itself (credits through a Masumi Payment Service) is not set up: the Keeper's fee is paid over x402 into Masumi escrow, as everywhere else in PayOnProof.

Notes: the CLI's `--personal` Workspace path answered 404 on Core (`/v1/users/me/workspace-access`) on 31 Oct, so the Coworker runs in the organization Workspace.
