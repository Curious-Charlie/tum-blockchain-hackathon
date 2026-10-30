/**
 * Wallet roles of D5 ReproBounty. Each role has its own wallet
 * (`<ROLE>_MNEMONIC` in this app's .env).
 *
 *   npm run wallets -w apps/reprobounty            # create wallets, show balances
 *   npm run wallets -w apps/reprobounty -- --fund  # top up paying roles from the treasury
 */
import { ada, usdm, type RoleSpec } from "@agentic/core";

export const roles: RoleSpec[] = [
  // posts the bounty and pays for a verified reproduction (x402)
  { role: "REQUESTER", name: "Requester (journal)", fund: [ada(25), usdm(30)] },
  // reproduces the paper; pays compute and verifier; publishes the certificate
  { role: "REPLICATOR", name: "Replicator agent", fund: [ada(30), usdm(20)] },
  // sells sandboxed code runs
  { role: "COMPUTE", name: "Compute agent" },
  // spot-checks the evidence bundle
  { role: "VERIFIER", name: "Verifier agent" },
];
