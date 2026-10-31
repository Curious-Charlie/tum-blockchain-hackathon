import type { Address, Hex } from 'viem';
import { type AirnodeV2Request, deriveRequestHash, fetchSignedResponse } from '../airnode-v2.ts';

export const TWITTERAPI_AIRNODE_V2_URL = 'https://airnode-twitterapi.fly.dev/';

// The address that the TwitterAPI.io Airnode v2 signs with, from the x-airnode extension of the document at its URL.
export const TWITTERAPI_AIRNODE_V2_ADDRESS: Address = '0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB';

// tweetsByIds answers {"tweets":[{"id":"…","text":"…","viewCount":120,"author":{"userName":"…"},…}],…}, and the
// projection cuts that down to {"author":"…","id":"…","text":"…","views":120}. CreatorDealEscrow rebuilds the same
// request from the tweet id, so the two must stay in step.
export const TWEET_PROJECTION = {
  author: '/tweets/0/author/userName',
  id: '/tweets/0/id',
  text: '/tweets/0/text',
  views: '/tweets/0/viewCount',
};

export const buildTweetRequest = (tweetId: string): AirnodeV2Request => ({
  operation: 'tweetsByIds',
  parameters: { tweet_ids: tweetId },
  responseProjection: TWEET_PROJECTION,
});

export const deriveTweetRequestHash = (tweetId: string): Hex => deriveRequestHash(buildTweetRequest(tweetId));

// Pass a paying fetch from createPayingFetch in x402.ts: every TwitterAPI.io operation costs 0.01 aUSD.
export const fetchSignedTweet = (tweetId: string, fetchFunction: typeof fetch) =>
  fetchSignedResponse(TWITTERAPI_AIRNODE_V2_URL, buildTweetRequest(tweetId), fetchFunction);

// X ids are Snowflake ids: the top bits are milliseconds since 2010-11-04T01:42:54.657Z.
export const tweetPostedAt = (tweetId: string) => Number((BigInt(tweetId) >> 22n) + 1288834974657n) / 1000;

export interface FoundTweet {
  id: string;
  text: string;
  viewCount: number;
  author: { userName: string };
}

// Discovery only: the settlement agent finds the post with searchTweets, but nothing from this answer goes on chain.
export const searchTweets = async (query: string, fetchFunction: typeof fetch): Promise<FoundTweet[]> => {
  const signed = await fetchSignedResponse(
    TWITTERAPI_AIRNODE_V2_URL,
    { operation: 'searchTweets', parameters: { query, queryType: 'Latest' } },
    fetchFunction
  );
  return (JSON.parse(signed.data) as { tweets?: FoundTweet[] }).tweets ?? [];
};
