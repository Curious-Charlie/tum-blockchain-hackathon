/**
 * Wallet roles of D1 PayOnProof. Each role has its own wallet
 * (`<ROLE>_MNEMONIC` in this app's .env); each Keeper also has its own EVM key
 * (`<ROLE>_EVM_PRIVATE_KEY`, created on first use).
 *
 *   npm run wallets -w apps/payonproof            # create wallets, show balances
 *   npm run wallets -w apps/payonproof -- --fund  # top up paying roles from the treasury
 */
import { ada, usdm, type RoleSpec } from "@agentic/core";

export const roles: RoleSpec[] = [
  // pays the Keepers' service fees: locked in Masumi escrow (tUSDM), or per attempt over x402 (tADA)
  { role: "LENA", name: "Lena's finance agent", fund: [ada(40), usdm(30)] },
  // Keepers execute invoice orders when their condition holds; they earn fees and pay for
  // receipts and escrow transactions in tADA, and for EVM gas with their own EVM key
  { role: "KEEPER", name: "Keeper Atlas", fund: [ada(20)] },
  { role: "KEEPER_B", name: "Keeper Swift", fund: [ada(20)] },
  { role: "KEEPER_C", name: "Keeper Prime", fund: [ada(10)] },
];
