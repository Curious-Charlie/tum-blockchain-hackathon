/**
 * Wallet roles of D1 PayOnProof. Each role has its own wallet
 * (`<ROLE>_MNEMONIC` in this app's .env).
 *
 *   npm run wallets -w apps/payonproof            # create wallets, show balances
 *   npm run wallets -w apps/payonproof -- --fund  # top up paying roles from the treasury
 */
import { ada, type RoleSpec } from "@agentic/core";

export const roles: RoleSpec[] = [
  // pays the Keeper's service fee (x402)
  { role: "LENA", name: "Lena's finance agent", fund: [ada(40)] },
  // executes the invoice when the condition holds; earns the fee
  { role: "KEEPER", name: "Keeper agent" },
];
