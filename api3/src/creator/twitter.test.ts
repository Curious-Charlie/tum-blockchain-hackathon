import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { recoverSigner, type SignedResponse } from '../airnode-v2.ts';
import { deriveTweetRequestHash, tweetPostedAt, TWITTERAPI_AIRNODE_V2_ADDRESS } from './twitter.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')) as SignedResponse;

test('the off-chain request hash is the one that TwitterAPI.io signed (and that CreatorDealEscrow rebuilds)', async () => {
  for (const [tweetId, name] of [
    ['2114718447817064611', 'twitterapi-api3dao-tbc-munich.json'],
    ['2088256120674570369', 'twitterapi-api3dao-viral.json'],
  ] as const) {
    const signed = fixture(name);
    assert.equal(deriveTweetRequestHash(tweetId), signed.requestHash);
    assert.equal(await recoverSigner(signed), TWITTERAPI_AIRNODE_V2_ADDRESS);
  }
});

test('reads the post time from the Snowflake id', () => {
  assert.equal(new Date(tweetPostedAt('2114718447817064611') * 1000).toISOString(), '2026-10-26T13:59:02.185Z');
});
