// Buys a signed, projected tweetsByIds response for 0.01 aUSD and checks its request hash and signer.
// Usage: node --env-file=… src/creator/fetch-tweet.ts <tweetId> [out.json]
import { writeFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { verifySignedResponse } from '../airnode-v2.ts';
import { createPayingFetch } from '../x402.ts';
import { deriveTweetRequestHash, fetchSignedTweet, TWITTERAPI_AIRNODE_V2_ADDRESS } from './twitter.ts';

const [tweetId, out] = process.argv.slice(2);
const signed = await fetchSignedTweet(tweetId, createPayingFetch(process.env.KEEPER_C_EVM_PRIVATE_KEY as Hex));
await verifySignedResponse(signed, TWITTERAPI_AIRNODE_V2_ADDRESS, deriveTweetRequestHash(tweetId));
const json = JSON.stringify(signed, null, 2) + '\n';
if (out) writeFileSync(out, json);
console.log(json);
