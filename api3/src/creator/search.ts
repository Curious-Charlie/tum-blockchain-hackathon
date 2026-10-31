// Finds tweets with X's search syntax, paying 0.01 aUSD. Usage: node --env-file=… src/creator/search.ts '<query>'
import type { Hex } from 'viem';
import { createPayingFetch } from '../x402.ts';
import { searchTweets, tweetPostedAt } from './twitter.ts';

const pay = createPayingFetch(process.env.KEEPER_C_EVM_PRIVATE_KEY as Hex);
for (const tweet of await searchTweets(process.argv[2], pay)) {
  const posted = new Date(tweetPostedAt(tweet.id) * 1000).toISOString();
  console.log(tweet.id, '@' + tweet.author?.userName, tweet.viewCount, posted, JSON.stringify(tweet.text.slice(0, 140)));
}
