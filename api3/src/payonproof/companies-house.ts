/**
 * Companies House (UK company register) on AirnodeHub: a company's status, signed by its Airnode and paid over x402.
 * The projection keeps the signed data to {"status":"<company_status>"}, so the contract can compare bytes.
 */
import type { Address, Hex } from 'viem';
import { deriveRequestHash, verifySignedResponse, type AirnodeV2Request, type SignedResponse } from '../airnode-v2.ts';
import { createPayingFetch, readPaymentSettlement } from '../x402.ts';

export const COMPANIES_HOUSE_URL = 'https://airnode-companies-house.fly.dev/';
export const COMPANIES_HOUSE_AIRNODE: Address = '0x392228E5CCA260313e5ed337Ed3561B59A1e4bFF';
export const ACTIVE = '{"status":"active"}';

export const companyRequest = (companyNumber: string): AirnodeV2Request => ({
  operation: 'getCompanyProfile',
  parameters: { company_number: companyNumber },
  responseProjection: { status: '/company_status' },
});

/** What the payer stores in the order: binds the check to this company number and this projection */
export const companyRequestHash = (companyNumber: string): Hex => deriveRequestHash(companyRequest(companyNumber));

/** Buys the signed status (0.01 aUSD over x402) and checks signer and request as the contract will */
export async function fetchCompanyStatus(companyNumber: string, payerKey: Hex) {
  const response = await createPayingFetch(payerKey)(COMPANIES_HOUSE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(companyRequest(companyNumber)),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Companies House answered ${response.status}: ${(await response.text()).slice(0, 160)}`);
  const signed = (await response.json()) as SignedResponse;
  await verifySignedResponse(signed, COMPANIES_HOUSE_AIRNODE, companyRequestHash(companyNumber));
  const settlement = readPaymentSettlement(response) as { transaction?: Hex } | undefined;
  return { signed, status: (JSON.parse(signed.data) as { status: string }).status, paymentTx: settlement?.transaction };
}
