# CreatorDealEscrow: pay-per-post creator deals on signed X data

A prototype on the `api3/creator-escrow` branch, kept apart from the PayOnProof submission.

A brand locks a budget for a sponsored post on X. A creator posts. The contract pays out only when TwitterAPI.io's
response, signed through AirnodeHub, shows that:

- the post exists right now;
- it was written by the agreed creator;
- it contains the deal code;
- it was posted after the deal opened;
- it has been up for the hold period;
- it has enough views.

The creator gets views × price per 1000 views, up to a cap. Whoever submits the proof gets a fixed settler fee in the
same transaction, and the rest goes back to the brand.

The problem it addresses: brands fear deleted posts and faked screenshots, and creators fear brands that pay late or
never. A signature replaces the screenshot. **AI can find the post, but the contract decides.** No LLM is on the money
path.

## Who relies on the signed data

| Party            | Relies on it for                                                                    | If the data were forged                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brand            | Paying only for a real, live post by the right person, priced on real views         | Inflated views overpay the creator. Someone else's post pays the wrong person. A deleted post still gets paid, so the brand pays for promotion it never got.      |
| Creator          | Getting paid without chasing the brand: the budget is locked, and anyone can settle | A forged "post missing" or "too few views" answer would withhold earned money. Because the contract checks the signature, only TwitterAPI.io's own answer counts. |
| Settlement agent | Being paid its fee only for a proof that the contract accepts                       | A fake proof reverts. The agent loses gas and earns nothing.                                                                                                      |

## How `settle` decides

`settle(dealId, tweetId, timestamp, data, signature)` in
[`contracts/creator/CreatorDealEscrow.sol`](contracts/creator/CreatorDealEscrow.sol):

1. **Signer and request.** The contract rebuilds the AirnodeHub request hash from `tweetId`:
   `keccak256('["tweetsByIds",[["tweet_ids","<id>"]],[["author","/tweets/0/author/userName"],["id","/tweets/0/id"],["text","/tweets/0/text"],["views","/tweets/0/viewCount"]]]')`.
   Then `AirnodeV2Attestation.verify` checks that TwitterAPI.io's Airnode
   (`0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB`) signed this request. The caller never supplies the hash, so a response
   to any other tweet, projection or operation recovers another signer and reverts.
2. **Freshness.** The response must be at most 2 minutes old. For a tweet that no longer resolves, the Airnode does
   not sign an answer. It returns 400 `The response has no value at "/tweets/0/author/userName"`; we observed this with
   the listing's example id. A fresh signature therefore shows that the post was still up at signing time.
3. **Time from the id.** X ids are Snowflake ids, so the post time is `((id >> 22) + 1288834974657) / 1000`. The
   contract parses no date strings. The post time must be at least `notBefore`. Post time + `holdSeconds` must be at
   most the signed timestamp.
4. **Content, on the signed bytes.** The contract reads the signed fields with `ProjectedJson`:
   - `id` must equal the tweet id;
   - `author` must equal the creator's handle, ignoring case;
   - `text` must contain the code;
   - `views` must be at least `minViews`.
5. **Money, atomically.** The payout is `min(maxPayout, views × payPerKViews / 1000)` and goes to the creator.
   `settlerFee` goes to `msg.sender`, and the rest goes back to the brand. Each deal settles once, and each tweet pays
   one deal. `refund(dealId)` returns the whole deposit after the deadline.

## Run it

All commands run from `api3/`. The scripts load `.env` and `../cardano/apps/payonproof/.env`. The brand and deployer is
`KEEPER_EVM_PRIVATE_KEY`, the settlement agent is `KEEPER_C_EVM_PRIVATE_KEY`, and the creator's payee address comes from
`CREATOR_EVM_PRIVATE_KEY`.

```sh
forge test --match-contract CreatorDealEscrow   # 17 tests: the real signed responses, the tamper cases, the business rules
pnpm test                                       # includes the off-chain request-hash check
forge build && pnpm creator:deploy              # deploys and writes src/creator/deployment.json
pnpm creator:brand Api3DAO @tbc_munich 2026-10-25T00:00:00Z 86400 1000 1 5 0.1 2
#                  handle  code        notBefore            hold  minViews dUSD/1k max fee days
pnpm creator:tamper 1                           # sends the 4 tamper cases + 2 dishonest claims; all revert on chain
pnpm creator:agent -- --rounds 10 --every 60    # the autonomous settlement agent
```

`agent.ts` is the autonomous settlement agent. Each round, for every open deal, it:

1. searches `from:<handle> "<code>"` with `searchTweets`. This step only discovers candidates and is never checked on
   chain;
2. skips posts that are too old, already used, or still within the hold period;
3. buys the signed `tweetsByIds` answer over x402 (0.01 aUSD, Base Sepolia);
4. checks the signer and request hash locally, then simulates `settle` and sends it.

## Live run on Base Sepolia (2026-10-31)

**The positive example uses an existing public tweet, not a sponsored post made for this deal.** The user chose not to
post. The deal is for [@Api3DAO's tweet](https://x.com/Api3DAO/status/2114718447817064611), posted
2026-10-26T13:59:02Z, which announces the team's trip to "@tbc_munich". The deal code is `@tbc_munich`. `notBefore` is
2026-10-25, before that post, and the hold period is 1 day. The deal requires 1000 views and pays 1 dUSD per 1000
views, with a cap of 5 dUSD and a 0.1 dUSD settler fee. The payee is a fresh demo address
(`0x2CAdF8fE22361AE7305F944e3da211c0f07d0764`), not an account of API3's. The token is DemoUSD
(`0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf`).

- Escrow: [`0x366b846fa22f6641fb4054ec52bc71e5d27e95b2`](https://sepolia.basescan.org/address/0x366b846fa22f6641fb4054ec52bc71e5d27e95b2)
- The receipt of every transaction below was fetched over RPC.

| Step                                                                                                                                                | Result                        | Transaction                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy                                                                                                                                              | success                       | [0x63d9abe3…](https://sepolia.basescan.org/tx/0x63d9abe37370d6d40410e52c6ff834de74a5f7d5fa5a896884376c0cc0d5bef5)                                                                                                         |
| Brand mints and approves 5.1 dUSD                                                                                                                   | success                       | [mint](https://sepolia.basescan.org/tx/0x1aa43d7cef7c1ba2a8a3dc2a23ef8ad615aa4425420a3e9b813604dd8c134d45), [approve](https://sepolia.basescan.org/tx/0x8e7c928071df5fa805dff7fe797e100348f6893943bcb2755004c409a6c36cea) |
| `createDeal` (deal 1) locks 5.1 dUSD                                                                                                                | success                       | [0x580b1792…](https://sepolia.basescan.org/tx/0x580b179257c09b541fb3ea94dbd66b4c29c7154f411293f2137b7f78b28beb3d)                                                                                                         |
| Tamper 1: views 2567 → 2567000 in the signed data                                                                                                   | reverted `NotSignedByAirnode` | [0x6b4292be…](https://sepolia.basescan.org/tx/0x6b4292beb27a3e8afcaa0260b2961e4db213c917a5df8804c72852ff0d33d535)                                                                                                         |
| Tamper 2: a genuine response signed more than 2 minutes earlier                                                                                     | reverted `ResponseTooOld`     | [0x7aaa092c…](https://sepolia.basescan.org/tx/0x7aaa092cbd78222b134ac23bb46f313728cd3eef9853e48e8519418ad4c87892)                                                                                                         |
| Tamper 3: the genuine signed response for another, more viral tweet (20704 views)                                                                   | reverted `NotSignedByAirnode` | [0x01d42396…](https://sepolia.basescan.org/tx/0x01d42396044d8da6f8b16323fe4889c702b9fd08df5b68c0bbaccb893c72b073)                                                                                                         |
| Tamper 4: the real data, re-signed with another key                                                                                                 | reverted `NotSignedByAirnode` | [0xe37b5f78…](https://sepolia.basescan.org/tx/0xe37b5f78cf204630eb3a46d9234ee260cfb7d37de5a132dc494b977a55e76d30)                                                                                                         |
| Negative 5: a genuine signed post by another account (@stan_duel_duck) that contains the code                                                       | reverted `WrongAuthor`        | [0x49fe29ef…](https://sepolia.basescan.org/tx/0x49fe29efe0023394740b0e21a7bb93ec203817e8944a5f8dd3c191f6c7af7537)                                                                                                         |
| Negative 6: a genuine signed @Api3DAO post from 2024 that contains the code                                                                         | reverted `PostedTooEarly`     | [0x244f1184…](https://sepolia.basescan.org/tx/0x244f11849ad7568ae34c97681b5e08f24a8a0c443a763f1936bd841813e03815)                                                                                                         |
| Agent pays 0.01 aUSD over x402 for `searchTweets`                                                                                                   | success                       | [0xc204d006…](https://sepolia.basescan.org/tx/0xc204d006fc9eba31fb76daa1a79bbd4eb1d87867dd6aaa7a39464a7d9c42f18b)                                                                                                         |
| Agent pays 0.01 aUSD over x402 for the signed `tweetsByIds`                                                                                         | success                       | [0x3ccc995f…](https://sepolia.basescan.org/tx/0x3ccc995f3f8d65daaa81a0fa428efc53620719bc1d8eaf64462c13645300e6d1)                                                                                                         |
| **`settle`**: 2567 signed views pay 2.567 dUSD to the creator, a 0.1 dUSD fee to the agent and a 2.433 dUSD refund to the brand, in one transaction | success                       | [0x1f28ea55…](https://sepolia.basescan.org/tx/0x1f28ea5561a6e828d261f7b99b198c14cb2f0d61fa202f22dcdeabf6e289cfce)                                                                                                         |

Gas: deploy 2.73M, `createDeal` 311k, `settle` 385k. The reverts used 41k–104k each.

The forge tests run the same four tamper cases against two recorded TwitterAPI.io responses
(`test/fixtures/twitterapi-*.json`). `test_requestHashMatchesTheAirnodes` shows that the hash the contract builds equals
the hash the Airnode signed. `twitter.test.ts` checks the same for the off-chain builder.

## Honest gaps

- **The views are X's own number.** Bot views count. The signature proves who said it (TwitterAPI.io), not that people
  saw the post.
- **TwitterAPI.io is a third-party source**, not X itself. The contract trusts its Airnode key.
- **The hold period is checked once, at settlement.** A post that disappeared for a while and came back would still
  pay. Nothing proves that it stayed visible the whole time.
- **Whoever settles first fixes the view count.** `settle` is open to anyone, and views are counted at that moment. A
  brand could settle as soon as the hold period ends, to pay for fewer views. The creator or the agent can settle too.
  A real deal would add a settlement window, or settle on the views at a fixed time.
- **Handles can change.** The deal binds the `userName`. An account that renames, or a handle that someone else takes
  over, would break that binding. Binding X's numeric user id instead would be stronger.
- **The code check is a substring match** on the text, as X returns it (HTML entities such as `&amp;` stay escaped).
- **X only.** AirnodeHub has no TikTok or Instagram source today.
- **Demo data.** The live example is an existing API3 tweet, not a sponsored post, and the payee is a demo address.
  The amounts are in DemoUSD on a testnet.
