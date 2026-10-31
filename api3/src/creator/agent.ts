// The settlement agent. For every open deal it finds the creator's post with searchTweets (discovery only: nothing from
// that answer goes on chain), waits until the hold period is over, buys TwitterAPI.io's signed tweetsByIds answer over
// x402 (0.01 aUSD), checks it as the contract will, and calls settle, which pays the agent the deal's settler fee in
// the same transaction. No LLM anywhere on this path: the contract decides on the signed bytes.
// Usage: agent.ts [--rounds N] [--every seconds]
import { type Address, formatUnits, type Hex, parseEventLogs, toHex } from 'viem';
import { verifySignedResponse } from '../airnode-v2.ts';
import { createPayingFetch, readPaymentSettlement } from '../x402.ts';
import { agentKey, confirm, ESCROW_ABI, publicClient, readDeployment, walletFor } from './chain.ts';
import {
  deriveTweetRequestHash,
  fetchSignedTweet,
  searchTweets,
  tweetPostedAt,
  TWITTERAPI_AIRNODE_V2_ADDRESS,
} from './twitter.ts';

interface Deal {
  brand: Address;
  status: number;
  terms: {
    creatorHandle: string;
    code: string;
    notBefore: bigint;
    holdSeconds: bigint;
    deadline: bigint;
    minViews: bigint;
    payPerKViews: bigint;
    maxPayout: bigint;
    settlerFee: bigint;
  };
}

const argument = (name: string, fallback: number) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const rounds = argument('--rounds', 1);
const every = argument('--every', 60);

const { escrow } = readDeployment();
const wallet = walletFor(agentKey());
// Wraps fetch to pay each call in aUSD, and logs the x402 payment transaction that the facilitator submitted.
const payingFetch = createPayingFetch(agentKey());
const pay: typeof fetch = async (input, init) => {
  const response = await payingFetch(input, init);
  const settlement = readPaymentSettlement(response) as { transaction?: Hex } | undefined;
  if (settlement?.transaction)
    console.log(`  paid 0.01 aUSD over x402: https://sepolia.basescan.org/tx/${settlement.transaction}`);
  return response;
};
const read = <T>(functionName: string, args: unknown[]) =>
  publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName, args }) as Promise<T>;

const settleDeal = async (dealId: bigint, deal: Deal) => {
  const { creatorHandle, code, notBefore, holdSeconds, minViews } = deal.terms;
  const now = Date.now() / 1000;
  const query = `from:${creatorHandle} "${code}"`;
  console.log(`deal ${dealId}: searching ${query}`);
  const found = (await searchTweets(query, pay))
    .filter((tweet) => tweet.author?.userName?.toLowerCase() === creatorHandle.toLowerCase())
    .filter((tweet) => tweet.text.includes(code) && tweetPostedAt(tweet.id) >= Number(notBefore));
  const used = await Promise.all(found.map((tweet) => read<bigint>('dealOfTweet', [BigInt(tweet.id)])));
  const candidates = found.filter((_, index) => used[index] === 0n).toSorted((a, b) => b.viewCount - a.viewCount);
  if (candidates.length === 0) return console.log(`deal ${dealId}: no post yet`);
  const ready = candidates.filter((tweet) => tweetPostedAt(tweet.id) + Number(holdSeconds) <= now);
  const [tweet] = ready;
  if (!tweet) {
    const [first] = candidates as [(typeof candidates)[number]];
    const waitUntil = new Date((tweetPostedAt(first.id) + Number(holdSeconds)) * 1000).toISOString();
    return console.log(`deal ${dealId}: post ${first.id} found, hold period ends ${waitUntil}`);
  }
  console.log(
    `deal ${dealId}: post https://x.com/${creatorHandle}/status/${tweet.id} (${tweet.viewCount} views in search)`
  );

  // The proof: TwitterAPI.io's signed answer for this one tweet id, checked as the contract will check it.
  const signed = await fetchSignedTweet(tweet.id, pay);
  await verifySignedResponse(signed, TWITTERAPI_AIRNODE_V2_ADDRESS, deriveTweetRequestHash(tweet.id));
  const data = JSON.parse(signed.data) as { author: string; text: string; views: number };
  if (data.views < Number(minViews))
    return console.log(`deal ${dealId}: ${data.views} signed views < ${minViews}, waiting`);

  const { request } = await publicClient.simulateContract({
    account: wallet.account,
    address: escrow,
    abi: ESCROW_ABI,
    functionName: 'settle',
    args: [dealId, BigInt(tweet.id), BigInt(signed.timestamp), toHex(signed.data), signed.signature],
  });
  const receipt = await confirm(await wallet.writeContract(request), `deal ${dealId}: settle`);
  const logs = parseEventLogs({ abi: ESCROW_ABI, logs: receipt.logs });
  for (const log of logs) {
    const fields = log.args as Record<string, bigint | string>;
    if (log.eventName === 'DealSettled')
      console.log(`  creator paid ${formatUnits(fields.payout as bigint, 6)} dUSD for ${fields.views} signed views`);
    if (log.eventName === 'SettlerPaid')
      console.log(
        `  agent fee ${formatUnits(fields.fee as bigint, 6)} dUSD, brand refund ${formatUnits(fields.refund as bigint, 6)} dUSD`
      );
  }
};

for (let round = 1; round <= rounds; round++) {
  const count = await read<bigint>('dealCount', []);
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (let dealId = 1n; dealId <= count; dealId++) {
    const deal = await read<Deal>('getDeal', [dealId]);
    if (deal.status !== 1 || deal.terms.deadline < now) continue;
    try {
      await settleDeal(dealId, deal);
    } catch (error) {
      console.log(`deal ${dealId}: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  if (round < rounds) await new Promise((resolve) => setTimeout(resolve, every * 1000));
}
