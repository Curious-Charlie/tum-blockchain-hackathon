/**
 * Wallet roles of D2 CheckedFacts. Each role has its own wallet
 * (`<ROLE>_MNEMONIC` in this app's .env).
 *
 *   npm run wallets -w apps/checkedfacts            # create wallets, show balances
 *   npm run wallets -w apps/checkedfacts -- --fund  # top up paying roles from the treasury
 */
import { ada, usdm, type RoleSpec } from "@agentic/core";

export const roles: RoleSpec[] = [
  // buys a research report (x402)
  { role: "CUSTOMER", name: "Shop owner", fund: [ada(25), usdm(30)] },
  // writes the report; pays the fact-checker
  { role: "RESEARCHER", name: "Research agent", fund: [ada(25), usdm(20)] },
  // checks claims against their sources; paid per batch
  { role: "CHECKER", name: "Fact-checker agent" },
];
