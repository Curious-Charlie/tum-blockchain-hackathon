// One campaign cycle run by three agents, for the live page. Claude interprets (which post looks like a genuine
// promotion, how to read the brand's brief); deterministic code filters, clamps the terms to hard bounds, and the
// contract alone decides whether money moves.
import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatUnits,
  type Hex,
  http,
  maxUint256,
  parseEventLogs,
  parseUnits,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { verifySignedResponse } from '../airnode-v2.ts';
import { createPayingFetch } from '../x402.ts';
import { ESCROW_ABI } from './escrow-abi.ts';
import {
  deriveTweetRequestHash,
  type FoundTweet,
  fetchSignedTweet,
  searchTweets,
  tweetPostedAt,
  TWITTERAPI_AIRNODE_V2_ADDRESS,
} from './twitter.ts';

export const ESCROW = '0x366b846fa22f6641fb4054ec52bc71e5d27e95b2' as const;
export const DUSD = '0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf' as const;
const CODE = '@tbc_munich';
const CAMPAIGN_START = Date.parse('2026-10-24T00:00:00Z') / 1000;
const MIN_HOLD = 3600;
const HAIKU = 'claude-haiku-5-5';
const BRIEF =
  'Pay creators who post about our presence at the TUM Blockchain & AI hackathon with @tbc_munich: 1 dUSD per 1000 ' +
  'views, at most 5 dUSD per post, at least 100 views, the post must have been up for at least 1 hour, 0.1 dUSD fee ' +
  'for whoever settles.';

const DUSD_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export interface TeamEvent {
  agent: 'system' | 'scout' | 'brand' | 'settler';
  kind: 'say' | 'think' | 'tx' | 'done' | 'error';
  text: string;
  tx?: Hex;
  data?: Record<string, unknown>;
}
export type Emit = (event: TeamEvent) => void;

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

// Claude over the Messages API. Interpretation only: every answer is validated or clamped by code below.
const askClaude = async (prompt: string): Promise<Record<string, unknown>> => {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Claude answered ${response.status}: ${(await response.text()).slice(0, 160)}`);
  const message = (await response.json()) as { stop_reason?: string; content: { type: string; text?: string }[] };
  if (message.stop_reason === 'refusal') throw new Error('Claude declined');
  const text = message.content.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : [])).join('');
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`no JSON in Claude's answer: ${text.slice(0, 120)}`);
  return JSON.parse(json) as Record<string, unknown>;
};

const short = (text: string, length = 110) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};
const dusd = (amount: bigint) => formatUnits(amount, 6);
const clamp = (value: unknown, low: number, high: number, fallbackValue: number) => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallbackValue;
};

export const runCampaign = async (emit: Emit, { dryRun = false } = {}) => {
  const transport = fallback([
    http(process.env.RPC_URL || 'https://sepolia.base.org', { retryCount: 4, retryDelay: 800 }),
    http('https://base-sepolia-rpc.publicnode.com', { retryCount: 4, retryDelay: 800 }),
  ]);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const brandKey = env('KEEPER_EVM_PRIVATE_KEY') as Hex;
  const settlerKey = env('KEEPER_C_EVM_PRIVATE_KEY') as Hex;
  const payee = env('CREATOR_PAYEE_ADDRESS') as Hex;
  const brand = createWalletClient({ account: privateKeyToAccount(brandKey), chain: baseSepolia, transport });
  const settler = createWalletClient({ account: privateKeyToAccount(settlerKey), chain: baseSepolia, transport });
  // The settler pays every TwitterAPI.io call in aUSD over x402; the facilitator submits the transfer.
  const pay = createPayingFetch(settlerKey);

  emit({
    agent: 'system',
    kind: 'say',
    text: `Campaign cycle${dryRun ? ' (dry run: nothing is sent)' : ''}. Code ${CODE}, escrow ${ESCROW} on Base Sepolia.`,
  });

  // ---- 1. Scout: find candidate posts (discovery only), filter deterministically, let Claude pick ----
  const now = Date.now() / 1000;
  const eligible = (tweets: FoundTweet[]) =>
    tweets.filter(
      (tweet) =>
        tweet.text.includes(CODE) &&
        tweet.viewCount >= 100 &&
        tweetPostedAt(tweet.id) >= CAMPAIGN_START &&
        tweetPostedAt(tweet.id) + MIN_HOLD <= now &&
        Boolean(tweet.author?.userName)
    );
  // Original posts ranked by X first; if none qualifies, the latest posts of any kind.
  let query = `"${CODE}" -filter:retweets -filter:replies since:2026-10-24`;
  emit({
    agent: 'scout',
    kind: 'say',
    text: `Searching X through TwitterAPI.io on AirnodeHub (0.01 aUSD over x402): ${query}`,
  });
  let found = await searchTweets(query, pay, 'Top');
  let basic = eligible(found);
  if (basic.length === 0) {
    query = `"${CODE}" -filter:retweets since:2026-10-24`;
    emit({ agent: 'scout', kind: 'say', text: `Nothing eligible among top posts; searching the latest: ${query}` });
    found = await searchTweets(query, pay, 'Latest');
    basic = eligible(found);
  }
  const used = basic.length
    ? await publicClient.multicall({
        contracts: basic.map((tweet) => ({
          address: ESCROW,
          abi: ESCROW_ABI,
          functionName: 'dealOfTweet' as const,
          args: [BigInt(tweet.id)] as const,
        })),
        allowFailure: false,
      })
    : [];
  const candidates = basic
    .filter((_, index) => used[index] === 0n)
    .toSorted((a, b) => b.viewCount - a.viewCount)
    .slice(0, 6);
  emit({
    agent: 'scout',
    kind: 'say',
    text: `${found.length} posts found, ${candidates.length} pass the rules (contain ${CODE}, ≥ 100 views, posted since 2026-10-24 and ≥ 1 h ago, not paid yet).`,
  });
  if (candidates.length === 0) throw new Error('No eligible post right now');
  for (const tweet of candidates)
    emit({
      agent: 'scout',
      kind: 'say',
      text: `@${tweet.author.userName} · ${tweet.viewCount} views · "${short(tweet.text)}"`,
      data: { tweetId: tweet.id, author: tweet.author.userName, views: tweet.viewCount },
    });

  let chosen: FoundTweet = candidates[0]!;
  try {
    const answer = await askClaude(
      `You are the scout for a brand's creator campaign at the TUM Blockchain & AI hackathon (code ${CODE}). ` +
        'Below are public posts on X. Pick the one that most looks like a genuine post promoting the event ' +
        '(not a reply thread, giveaway spam or an unrelated mention). Answer with JSON only: ' +
        '{"tweetId": "<id from the list>", "reason": "<one sentence>"}.\n\n' +
        candidates
          .map((tweet) =>
            JSON.stringify({ id: tweet.id, author: tweet.author.userName, views: tweet.viewCount, text: tweet.text })
          )
          .join('\n')
    );
    const pick = candidates.find((tweet) => tweet.id === String(answer.tweetId));
    if (!pick) throw new Error(`Claude picked ${String(answer.tweetId)}, which is not on the list`);
    chosen = pick;
    emit({ agent: 'scout', kind: 'think', text: String(answer.reason ?? '') });
  } catch (error) {
    emit({
      agent: 'scout',
      kind: 'error',
      text: `Claude's pick unavailable (${(error as Error).message}); falling back to the most-viewed post.`,
    });
  }
  const postUrl = `https://x.com/${chosen.author.userName}/status/${chosen.id}`;
  emit({
    agent: 'scout',
    kind: 'say',
    text: `Proposed post: ${postUrl} by @${chosen.author.userName}`,
    data: { tweetId: chosen.id, url: postUrl },
  });

  // ---- 2. Brand: Claude reads the brief, code clamps the terms, the brand locks the budget ----
  let proposed: Record<string, unknown> = {};
  try {
    proposed = await askClaude(
      'You are a brand agent. Turn this campaign brief into deal terms. Answer with JSON only: ' +
        '{"payPerKViews": <dUSD per 1000 views>, "maxPayout": <dUSD>, "minViews": <integer>, "holdSeconds": <integer>, ' +
        '"settlerFee": <dUSD>, "rationale": "<one sentence>"}.\n\nBrief: ' +
        BRIEF
    );
    emit({ agent: 'brand', kind: 'think', text: String(proposed.rationale ?? '') });
  } catch (error) {
    emit({
      agent: 'brand',
      kind: 'error',
      text: `Claude's terms unavailable (${(error as Error).message}); using the brief's numbers.`,
    });
  }
  const terms = {
    token: DUSD,
    creatorPayee: payee,
    creatorHandle: chosen.author.userName,
    code: CODE,
    notBefore: BigInt(CAMPAIGN_START),
    holdSeconds: BigInt(Math.round(clamp(proposed.holdSeconds, MIN_HOLD, 7 * 86400, MIN_HOLD))),
    deadline: BigInt(Math.floor(now) + 86400),
    minViews: BigInt(Math.round(clamp(proposed.minViews, 50, 1_000_000, 100))),
    payPerKViews: parseUnits(clamp(proposed.payPerKViews, 0.01, 2, 1).toFixed(6), 6),
    maxPayout: parseUnits(clamp(proposed.maxPayout, 0.01, 5, 5).toFixed(6), 6),
    settlerFee: parseUnits(clamp(proposed.settlerFee, 0, 0.1, 0.1).toFixed(6), 6),
  };
  // The search numbers are unsigned, so they only keep the brand from opening a deal that cannot settle.
  if (tweetPostedAt(chosen.id) + Number(terms.holdSeconds) > now) terms.holdSeconds = BigInt(MIN_HOLD);
  if (terms.minViews > BigInt(chosen.viewCount)) terms.minViews = 100n;
  emit({
    agent: 'brand',
    kind: 'say',
    text:
      `Terms after hard bounds: ${dusd(terms.payPerKViews)} dUSD per 1000 views, cap ${dusd(terms.maxPayout)} dUSD, ` +
      `≥ ${terms.minViews} views, up ≥ ${Number(terms.holdSeconds) / 3600} h, settler fee ${dusd(terms.settlerFee)} dUSD, ` +
      `creator @${terms.creatorHandle}, deadline in 24 h.`,
    data: {
      terms: {
        ...terms,
        notBefore: String(terms.notBefore),
        holdSeconds: String(terms.holdSeconds),
        deadline: String(terms.deadline),
        minViews: String(terms.minViews),
        payPerKViews: dusd(terms.payPerKViews),
        maxPayout: dusd(terms.maxPayout),
        settlerFee: dusd(terms.settlerFee),
      },
    },
  });
  emit({
    agent: 'brand',
    kind: 'say',
    text: `Note: this is a retroactive bounty on a post that already exists, and the payee ${payee} is a demo address, not @${terms.creatorHandle}'s.`,
  });

  const deposit = terms.maxPayout + terms.settlerFee;
  const brandAddress = brand.account.address;
  const [balance, allowance] = await Promise.all([
    publicClient.readContract({ address: DUSD, abi: DUSD_ABI, functionName: 'balanceOf', args: [brandAddress] }),
    publicClient.readContract({
      address: DUSD,
      abi: DUSD_ABI,
      functionName: 'allowance',
      args: [brandAddress, ESCROW],
    }),
  ]);
  if (balance < deposit) {
    if (dryRun) emit({ agent: 'brand', kind: 'say', text: 'Would mint 100000 dUSD first (dry run).' });
    else {
      const hash = await brand.writeContract({
        address: DUSD,
        abi: DUSD_ABI,
        functionName: 'mint',
        args: [brandAddress, 100_000_000_000n],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      emit({ agent: 'brand', kind: 'tx', text: 'Minted 100000 dUSD for the campaign budget', tx: hash });
    }
  }
  if (allowance < deposit) {
    if (dryRun) emit({ agent: 'brand', kind: 'say', text: 'Would approve the escrow first (dry run).' });
    else {
      const hash = await brand.writeContract({
        address: DUSD,
        abi: DUSD_ABI,
        functionName: 'approve',
        args: [ESCROW, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      emit({ agent: 'brand', kind: 'tx', text: 'Approved the escrow to take deposits', tx: hash });
    }
  }
  const { request } = await publicClient.simulateContract({
    account: brand.account,
    address: ESCROW,
    abi: ESCROW_ABI,
    functionName: 'createDeal',
    args: [terms],
  });
  if (dryRun) {
    emit({ agent: 'brand', kind: 'say', text: `createDeal simulated: it would lock ${dusd(deposit)} dUSD.` });
    emit({
      agent: 'system',
      kind: 'done',
      text: 'Dry run complete: nothing was sent.',
      data: { dryRun: true, tweetId: chosen.id },
    });
    return;
  }
  const createTx = await brand.writeContract(request);
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTx });
  if (createReceipt.status !== 'success') throw new Error(`createDeal reverted: ${createTx}`);
  const created = parseEventLogs({ abi: ESCROW_ABI, logs: createReceipt.logs, eventName: 'DealCreated' })[0];
  const dealId = created?.args.dealId ?? 0n;
  emit({
    agent: 'brand',
    kind: 'tx',
    text: `Deal ${dealId} opened: ${dusd(deposit)} dUSD locked in the escrow`,
    tx: createTx,
    data: { dealId: String(dealId) },
  });

  // ---- 3. Settler: buy the signed proof, check it, let the contract decide ----
  emit({
    agent: 'settler',
    kind: 'say',
    text: `Buying TwitterAPI.io's signed tweetsByIds answer for ${chosen.id} (0.01 aUSD over x402).`,
  });
  const signed = await fetchSignedTweet(chosen.id, pay);
  await verifySignedResponse(signed, TWITTERAPI_AIRNODE_V2_ADDRESS, deriveTweetRequestHash(chosen.id));
  const signedViews = (JSON.parse(signed.data) as { views?: number }).views;
  emit({
    agent: 'settler',
    kind: 'say',
    text: `Signature checked: signer ${TWITTERAPI_AIRNODE_V2_ADDRESS}, request hash ${signed.requestHash.slice(0, 10)}…, ${signedViews} signed views. Submitting to the contract.`,
  });
  const settleArgs = [
    dealId,
    BigInt(chosen.id),
    BigInt(signed.timestamp),
    toHex(signed.data),
    signed.signature,
  ] as const;
  const simulated = await publicClient.simulateContract({
    account: settler.account,
    address: ESCROW,
    abi: ESCROW_ABI,
    functionName: 'settle',
    args: settleArgs,
  });
  const settleTx = await settler.writeContract(simulated.request);
  const settleReceipt = await publicClient.waitForTransactionReceipt({ hash: settleTx });
  if (settleReceipt.status !== 'success') throw new Error(`settle reverted: ${settleTx}`);
  const logs = parseEventLogs({ abi: ESCROW_ABI, logs: settleReceipt.logs });
  let payout = 0n;
  let fee = 0n;
  let refund = 0n;
  let views = 0n;
  for (const log of logs) {
    if (log.eventName === 'DealSettled') ({ payout, views } = log.args);
    if (log.eventName === 'SettlerPaid') ({ fee, refund } = log.args);
  }
  emit({
    agent: 'settler',
    kind: 'tx',
    text: `Settled: ${views} signed views → ${dusd(payout)} dUSD to the creator, ${dusd(fee)} dUSD fee to the settler, ${dusd(refund)} dUSD back to the brand`,
    tx: settleTx,
  });
  emit({
    agent: 'system',
    kind: 'done',
    text: 'Campaign cycle complete.',
    data: {
      dealId: String(dealId),
      tweetId: chosen.id,
      settleTx,
      createTx,
      payout: dusd(payout),
      fee: dusd(fee),
      refund: dusd(refund),
    },
  });
};
