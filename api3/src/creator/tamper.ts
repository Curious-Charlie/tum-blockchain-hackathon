// Sends the API3 tamper cases and two dishonest claims to a live deal as real transactions, each with an explicit gas
// limit, and shows that the contract reverts every one. Run it before the agent settles the deal.
// Usage: tamper.ts <dealId>
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { BaseError, ContractFunctionRevertedError, encodePacked, keccak256, toHex } from 'viem';
import { readFileSync } from 'node:fs';
import { type SignedResponse } from '../airnode-v2.ts';
import { createPayingFetch } from '../x402.ts';
import { agentKey, ESCROW_ABI, publicClient, readDeployment, txLink, walletFor } from './chain.ts';
import { fetchSignedTweet } from './twitter.ts';

const API3_TWEET = '2114718447817064611'; // @Api3DAO, 2026-10-26, contains "@tbc_munich"
const OLD_API3_TWEET = '1834287089485316407'; // @Api3DAO, 2024-09-12, also contains "@tbc_munich"
const OTHER_AUTHOR_TWEET = '2116123237411336613'; // @stan_duel_duck, 2026-10-30, contains "@tbc_munich"

const dealId = BigInt(process.argv[2] ?? 1);
const { escrow } = readDeployment();
const wallet = walletFor(agentKey());
const pay = createPayingFetch(agentKey());
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')) as SignedResponse;

const fresh = await fetchSignedTweet(API3_TWEET, pay);
const forgerKey = generatePrivateKey();
const forged = await privateKeyToAccount(forgerKey).signMessage({
  message: {
    raw: keccak256(
      encodePacked(['bytes32', 'uint256', 'bytes'], [fresh.requestHash, BigInt(fresh.timestamp), toHex(fresh.data)])
    ),
  },
});

const cases: { name: string; tweetId: string; response: SignedResponse }[] = [
  {
    name: 'tamper 1: views inflated in the signed data',
    tweetId: API3_TWEET,
    response: { ...fresh, data: fresh.data.replace(/"views":(\d+)/, (_, views) => `"views":${views}000`) },
  },
  {
    name: 'tamper 2: stale response (signed more than 2 minutes ago)',
    tweetId: API3_TWEET,
    response: fixture('twitterapi-api3dao-tbc-munich.json'),
  },
  {
    name: "tamper 3: another request's response (a viral tweet's)",
    tweetId: API3_TWEET,
    response: fixture('twitterapi-api3dao-viral.json'),
  },
  { name: 'tamper 4: signed by another key', tweetId: API3_TWEET, response: { ...fresh, signature: forged } },
  {
    name: 'claim 5: post by another author with the code',
    tweetId: OTHER_AUTHOR_TWEET,
    response: await fetchSignedTweet(OTHER_AUTHOR_TWEET, pay),
  },
  {
    name: 'claim 6: old post from before the deal',
    tweetId: OLD_API3_TWEET,
    response: await fetchSignedTweet(OLD_API3_TWEET, pay),
  },
];

for (const { name, tweetId, response } of cases) {
  const args = [dealId, BigInt(tweetId), BigInt(response.timestamp), toHex(response.data), response.signature] as const;
  let reason = 'did not revert in simulation';
  try {
    await publicClient.simulateContract({
      account: wallet.account,
      address: escrow,
      abi: ESCROW_ABI,
      functionName: 'settle',
      args,
    });
  } catch (error) {
    const reverted =
      error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
    const data = reverted instanceof ContractFunctionRevertedError ? reverted.data : undefined;
    reason = data
      ? `${data.errorName}(${(data.args ?? []).map(String).join(', ')})`
      : String((error as Error).message.split('\n')[0]);
  }
  if (reason === 'did not revert in simulation') throw new Error(`${name}: the contract would accept it`);
  // Sent anyway, with a fixed gas limit, so the rejection is on chain.
  const hash = await wallet.writeContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: 'settle',
    args,
    gas: 400_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${name}\n  ${receipt.status} with ${reason}, gas ${receipt.gasUsed}\n  ${txLink(hash)}`);
}
