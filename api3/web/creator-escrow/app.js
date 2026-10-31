// Read-only view of CreatorDealEscrow on Base Sepolia. Holds no keys; every number comes from the chain.
import {
  createPublicClient,
  decodeFunctionData,
  encodeEventTopics,
  encodePacked,
  formatUnits,
  hexToString,
  http,
  keccak256,
  parseEventLogs,
  recoverMessageAddress,
  stringToBytes,
} from 'https://esm.sh/viem@2.57.3';
import { baseSepolia } from 'https://esm.sh/viem@2.57.3/chains';
import { ESCROW_ABI } from './abi.js';

const ESCROW = '0x366b846fa22f6641fb4054ec52bc71e5d27e95b2';
const AIRNODE = '0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB';
const TOKEN = { address: '0xdf6ffd0bccb883cf14bf45c2ef54f4ee95b2cbcf', symbol: 'dUSD', decimals: 6 };
const DEPLOY_BLOCK = 52646903;
const MAX_RESPONSE_AGE = 120n;
const TWITTER_EPOCH_MS = 1288834974657n;
const SCAN = 'https://sepolia.basescan.org';
const BLOCKSCOUT = 'https://base-sepolia.blockscout.com/api';
// Used only if Blockscout's log API is unreachable.
const KNOWN_SETTLES = ['0x1f28ea5561a6e828d261f7b99b198c14cb2f0d61fa202f22dcdeabf6e289cfce'];

const REJECTED = [
  {
    tx: '0x6b4292beb27a3e8afcaa0260b2961e4db213c917a5df8804c72852ff0d33d535',
    label: 'Tamper 1: views edited from 2567 to 2567000 inside the signed data',
    onchain: 'NotSignedByAirnode',
  },
  {
    tx: '0x7aaa092cbd78222b134ac23bb46f313728cd3eef9853e48e8519418ad4c87892',
    label: 'Tamper 2: a genuine response, signed more than 2 minutes before the block',
    onchain: 'ResponseTooOld',
  },
  {
    tx: '0x01d42396044d8da6f8b16323fe4889c702b9fd08df5b68c0bbaccb893c72b073',
    label: "Tamper 3: another, more viral tweet's genuine signed response, sent for this tweet",
    onchain: 'NotSignedByAirnode',
  },
  {
    tx: '0xe37b5f78cf204630eb3a46d9234ee260cfb7d37de5a132dc494b977a55e76d30',
    label: 'Tamper 4: the real data, re-signed with another key',
    onchain: 'NotSignedByAirnode',
  },
  {
    tx: '0x49fe29efe0023394740b0e21a7bb93ec203817e8944a5f8dd3c191f6c7af7537',
    label: 'Genuine signed post with the code, but by another account',
    onchain: 'WrongAuthor',
  },
  {
    tx: '0x244f11849ad7568ae34c97681b5e08f24a8a0c443a763f1936bd841813e03815',
    label: 'Genuine signed @Api3DAO post with the code, from 2024',
    onchain: 'PostedTooEarly',
  },
];

const TRAIL = [
  {
    tx: '0x580b179257c09b541fb3ea94dbd66b4c29c7154f411293f2137b7f78b28beb3d',
    label: 'Brand opens deal 1 and locks 5.1 dUSD (cap + fee)',
  },
  {
    tx: '0xc204d006fc9eba31fb76daa1a79bbd4eb1d87867dd6aaa7a39464a7d9c42f18b',
    label: 'Agent pays 0.01 aUSD over x402 for searchTweets',
  },
  {
    tx: '0x3ccc995f3f8d65daaa81a0fa428efc53620719bc1d8eaf64462c13645300e6d1',
    label: 'Agent pays 0.01 aUSD over x402 for the signed tweetsByIds answer',
  },
  {
    tx: '0x1f28ea5561a6e828d261f7b99b198c14cb2f0d61fa202f22dcdeabf6e289cfce',
    label: 'Agent calls settle: creator paid, agent fee, refund to brand, one transaction',
  },
];

const STATUS = ['None', 'Open', 'Settled', 'Refunded'];

const client = createPublicClient({
  chain: baseSepolia,
  transport: http('https://sepolia.base.org', { batch: true, retryCount: 5, retryDelay: 700 }),
});

// ---------- helpers ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (h) => `${h.slice(0, 8)}…${h.slice(-6)}`;
const txLink = (h, text = short(h)) =>
  `<a class="mono" href="${SCAN}/tx/${h}" target="_blank" rel="noopener">${esc(text)}</a>`;
const addrLink = (a, text = short(a)) =>
  `<a class="mono" href="${SCAN}/address/${a}" target="_blank" rel="noopener">${esc(text)}</a>`;
const amount = (v) => `${formatUnits(v, TOKEN.decimals)} ${TOKEN.symbol}`;
const utc = (secs) => new Date(Number(secs) * 1000).toISOString().replace('.000Z', 'Z').replace('T', ' ');
const duration = (secs) => {
  const s = Number(secs);
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? '' : 's'}`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
};

// The request hash the contract rebuilds from the tweet id (CreatorDealEscrow.tweetRequestHash).
const requestHashFor = (tweetId) =>
  keccak256(
    stringToBytes(
      `["tweetsByIds",[["tweet_ids","${tweetId}"]],[["author","/tweets/0/author/userName"],["id","/tweets/0/id"],["text","/tweets/0/text"],["views","/tweets/0/viewCount"]]]`
    )
  );

const postedAt = (tweetId) => ((tweetId >> 22n) + TWITTER_EPOCH_MS) / 1000n;

// AirnodeV2Attestation.recoverSigner: EIP-191 over keccak256(requestHash ‖ timestamp ‖ data).
const recoverSigner = (requestHash, timestamp, data, signature) =>
  recoverMessageAddress({
    message: { raw: keccak256(encodePacked(['bytes32', 'uint256', 'bytes'], [requestHash, timestamp, data])) },
    signature,
  });

const parseSigned = (data) => {
  const raw = hexToString(data);
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    return { raw, json: {} };
  }
};

// Re-runs settle's checks, in the contract's order, for one call. Status, deadline and reuse checks are not
// repeated here: they depend on the deal's state at that block.
async function recheck(terms, call, blockTime) {
  const { tweetId, timestamp, data, signature } = call;
  const { json } = parseSigned(data);
  const requestHash = requestHashFor(tweetId);
  let signer;
  try {
    signer = await recoverSigner(requestHash, timestamp, data, signature);
  } catch {
    signer = '(unrecoverable)';
  }
  const posted = postedAt(tweetId);
  const views = BigInt(json.views ?? 0);
  const age = blockTime - timestamp;
  const steps = [
    {
      name: 'Signer and request',
      ok: signer.toLowerCase() === AIRNODE.toLowerCase(),
      error: 'NotSignedByAirnode',
      detail: `request ${short(requestHash)} → recovered ${signer}${signer.toLowerCase() === AIRNODE.toLowerCase() ? ' (TwitterAPI.io Airnode)' : ' (not the Airnode)'}`,
    },
    {
      name: 'Fresh (≤ 2 min)',
      ok: timestamp + MAX_RESPONSE_AGE >= blockTime,
      error: 'ResponseTooOld',
      detail: `signed ${utc(timestamp)}, block ${utc(blockTime)}, age ${age} s`,
    },
    {
      name: 'Posted after notBefore',
      ok: posted >= terms.notBefore,
      error: 'PostedTooEarly',
      detail: `posted ${utc(posted)} (from the Snowflake id), notBefore ${utc(terms.notBefore)}`,
    },
    {
      name: 'Hold period over',
      ok: posted + terms.holdSeconds <= timestamp,
      error: 'HoldNotOver',
      detail: `posted + ${duration(terms.holdSeconds)} = ${utc(posted + terms.holdSeconds)} ≤ signed ${utc(timestamp)}`,
    },
    {
      name: 'Same tweet id',
      ok: String(json.id) === tweetId.toString(),
      error: 'WrongTweet',
      detail: `signed id ${json.id}`,
    },
    {
      name: 'Author is the creator',
      ok: String(json.author ?? '').toLowerCase() === terms.creatorHandle.toLowerCase(),
      error: 'WrongAuthor',
      detail: `signed author @${json.author}, deal @${terms.creatorHandle}`,
    },
    {
      name: 'Text contains the code',
      ok: String(json.text ?? '').includes(terms.code),
      error: 'CodeMissing',
      detail: `code "${terms.code}"`,
    },
    {
      name: 'Enough views',
      ok: views >= terms.minViews,
      error: 'NotEnoughViews',
      detail: `signed views ${views}, minimum ${terms.minViews}`,
    },
  ];
  const failed = steps.find((s) => !s.ok);
  return { steps, failed, requestHash, signer, views, json };
}

const renderSteps = (steps) => {
  let reached = true;
  return `<ul class="steps">${steps
    .map((s) => {
      const state = !reached ? 'skip' : s.ok ? 'ok' : 'bad';
      const icon = state === 'ok' ? '✓' : state === 'bad' ? '✗' : '–';
      const li = `<li class="${state}"><span class="icon">${icon}</span><span>${esc(s.name)}${state === 'skip' ? ' <small>(not reached)</small>' : ''}</span><span class="detail">${esc(s.detail)}</span></li>`;
      if (!s.ok) reached = false;
      return li;
    })
    .join('')}</ul>`;
};

async function loadCall(hash) {
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const { functionName, args } = decodeFunctionData({ abi: ESCROW_ABI, data: tx.input });
  if (functionName !== 'settle') throw new Error(`${hash} is not a settle call`);
  const [dealId, tweetId, timestamp, data, signature] = args;
  return { tx, receipt, blockTime: block.timestamp, call: { dealId, tweetId, timestamp, data, signature } };
}

const dealCache = new Map();
// Settle transactions from this page's own team runs, in case Blockscout has not indexed them yet.
const freshSettles = new Set();
const getDeal = async (id) => {
  if (!dealCache.has(id))
    dealCache.set(id, client.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: 'getDeal', args: [id] }));
  return dealCache.get(id);
};

async function settleTxs() {
  try {
    const [topic0] = encodeEventTopics({ abi: ESCROW_ABI, eventName: 'DealSettled' });
    const url = `${BLOCKSCOUT}?module=logs&action=getLogs&address=${ESCROW}&fromBlock=${DEPLOY_BLOCK}&toBlock=latest&topic0=${topic0}`;
    const res = await fetch(url);
    const body = await res.json();
    if (!Array.isArray(body.result)) throw new Error('no result');
    return [...new Set(body.result.map((l) => l.transactionHash))];
  } catch {
    return KNOWN_SETTLES;
  }
}

// ---------- sections ----------

async function renderDeals() {
  const el = document.getElementById('deals');
  dealCache.clear();
  const count = await client.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: 'dealCount' });
  const settles = [...new Set([...(await settleTxs()), ...freshSettles])];
  const settledBy = new Map();
  for (const hash of settles) {
    const loaded = await loadCall(hash);
    settledBy.set(loaded.call.dealId, { hash, ...loaded });
  }
  const cards = [];
  for (let id = count; id >= 1n; id--) {
    const deal = await getDeal(id);
    const t = deal.terms;
    const status = STATUS[deal.status] ?? String(deal.status);
    const pill = status === 'Settled' ? 'ok' : status === 'Open' ? 'open' : 'bad';
    let body = `
      <dl class="grid">
        <div><dt>Creator</dt><dd><a href="https://x.com/${esc(t.creatorHandle)}" target="_blank" rel="noopener">@${esc(t.creatorHandle)}</a></dd></div>
        <div><dt>Deal code</dt><dd class="mono">${esc(t.code)}</dd></div>
        <div><dt>Posts accepted from</dt><dd>${utc(t.notBefore)}</dd></div>
        <div><dt>Hold period</dt><dd>${duration(t.holdSeconds)}</dd></div>
        <div><dt>Minimum views</dt><dd>${t.minViews}</dd></div>
        <div><dt>Price</dt><dd>${amount(t.payPerKViews)} per 1000 views</dd></div>
        <div><dt>Cap</dt><dd>${amount(t.maxPayout)}</dd></div>
        <div><dt>Settler fee</dt><dd>${amount(t.settlerFee)}</dd></div>
        <div><dt>Deadline</dt><dd>${utc(t.deadline)}</dd></div>
        <div><dt>Brand</dt><dd>${addrLink(deal.brand)}</dd></div>
        <div><dt>Creator payee</dt><dd>${addrLink(t.creatorPayee)}</dd></div>
      </dl>`;
    const s = settledBy.get(id);
    if (s) {
      const check = await recheck(t, s.call, s.blockTime);
      const onchainHash = await client.readContract({
        address: ESCROW,
        abi: ESCROW_ABI,
        functionName: 'tweetRequestHash',
        args: [s.call.tweetId],
      });
      const logs = parseEventLogs({ abi: ESCROW_ABI, logs: s.receipt.logs });
      const settled = logs.find((l) => l.eventName === 'DealSettled')?.args;
      const paid = logs.find((l) => l.eventName === 'SettlerPaid')?.args;
      const tweetUrl = `https://x.com/${encodeURIComponent(check.json.author ?? t.creatorHandle)}/status/${s.call.tweetId}`;
      const agree = onchainHash.toLowerCase() === check.requestHash.toLowerCase();
      body += `
        <h3>Settled in ${txLink(s.hash)}</h3>
        <p>Post: <a href="${tweetUrl}" target="_blank" rel="noopener">${esc(tweetUrl)}</a></p>
        <blockquote>${esc(check.json.text ?? '')}</blockquote>
        <div class="split">
          <div><b>${amount(settled.payout)}</b><span>to the creator: ${settled.views} views × ${amount(t.payPerKViews)} / 1000, capped at ${amount(t.maxPayout)}</span></div>
          <div><b>${amount(paid.fee)}</b><span>settler fee to ${addrLink(paid.settler)}</span></div>
          <div><b>${amount(paid.refund)}</b><span>back to the brand</span></div>
        </div>
        <p class="note">All three transfers happen in this one transaction. These are the exact bytes TwitterAPI.io's Airnode signed:</p>
        <div class="signed">${esc(parseSigned(s.call.data).raw)}</div>
        <p class="verdict">Request hash rebuilt in your browser: <span class="mono">${short(check.requestHash)}</span>. The contract's <code>tweetRequestHash</code> gives <span class="mono">${short(onchainHash)}</span>: ${agree ? '<b style="color:var(--ok)">identical</b>' : '<b style="color:var(--bad)">different</b>'}.</p>
        ${renderSteps(check.steps)}
        <p class="verdict">Browser re-check: ${check.failed ? `<b style="color:var(--bad)">would revert with ${check.failed.error}</b>` : '<b style="color:var(--ok)">every check passes</b>, as on chain'}.</p>`;
    }
    cards.push(
      `<article class="card"><div class="card-head"><h3>Deal ${id}</h3><span class="pill ${pill}">${status}</span></div>${body}</article>`
    );
  }
  el.innerHTML = cards.join('') || '<p class="note">No deals yet.</p>';
}

async function renderRejected() {
  const el = document.getElementById('rejected');
  const cards = [];
  for (const r of REJECTED) {
    try {
      const { receipt, blockTime, call } = await loadCall(r.tx);
      const deal = await getDeal(call.dealId);
      const check = await recheck(deal.terms, call, blockTime);
      const predicted = check.failed?.error ?? 'none';
      const match = predicted === r.onchain;
      cards.push(`
        <article class="card">
          <div class="card-head"><h3>${esc(r.label)}</h3><span class="pill bad">${receipt.status === 'reverted' ? 'Reverted' : esc(receipt.status)}: ${esc(r.onchain)}</span></div>
          <p>Transaction ${txLink(r.tx)} · deal ${call.dealId} · tweet id <span class="mono">${call.tweetId}</span></p>
          <div class="signed">${esc(parseSigned(call.data).raw)}</div>
          ${renderSteps(check.steps)}
          <p class="verdict">Browser re-check stops at <b>${esc(predicted)}</b>: ${match ? '<b style="color:var(--ok)">matches the on-chain revert</b>' : '<b style="color:var(--bad)">does not match</b>'}.</p>
        </article>`);
    } catch (e) {
      cards.push(
        `<article class="card"><h3>${esc(r.label)}</h3><p>${txLink(r.tx)}</p><p class="error">Could not load: ${esc(e.shortMessage ?? e.message)}</p></article>`
      );
    }
  }
  el.innerHTML = cards.join('');
}

function renderStatic() {
  document.getElementById('fact-escrow').innerHTML = addrLink(ESCROW, ESCROW);
  document.getElementById('fact-airnode').innerHTML = addrLink(AIRNODE, AIRNODE);
  document.getElementById('fact-token').innerHTML =
    `${addrLink(TOKEN.address, `DemoUSD (${TOKEN.symbol})`)}, ${TOKEN.decimals} decimals`;
  document.getElementById('trail').innerHTML = TRAIL.map((t) => `<li>${esc(t.label)}: ${txLink(t.tx)}</li>`).join('');
}

renderStatic();
const fail = (id) => (e) => {
  console.error(e);
  document.getElementById(id).innerHTML =
    `<p class="error">Could not read Base Sepolia right now (${esc(e.shortMessage ?? e.message)}). Reload in a moment.</p>`;
};
renderDeals().catch(fail('deals'));
renderRejected().catch(fail('rejected'));

// ---------- the agent team (server side: /api/run streams NDJSON) ----------

const AGENTS = {
  system: { name: 'System', cls: 'a-system' },
  scout: { name: 'Scout', cls: 'a-scout' },
  brand: { name: 'Brand', cls: 'a-brand' },
  settler: { name: 'Settler', cls: 'a-settler' },
};

function logEvent(ev) {
  const log = document.getElementById('team-log');
  const agent = AGENTS[ev.agent] ?? AGENTS.system;
  const li = document.createElement('li');
  li.className = `ev ${agent.cls} k-${ev.kind ?? 'say'}`;
  const tx = ev.tx ? ` ${txLink(ev.tx)}` : '';
  li.innerHTML = `<span class="who">${esc(agent.name)}</span><span class="what">${esc(ev.text ?? '')}${tx}</span>`;
  log.appendChild(li);
  li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function runTeam(event) {
  event.preventDefault();
  const button = document.getElementById('team-run');
  const passcode = document.getElementById('team-pass').value.trim();
  const dryRun = document.getElementById('team-dry').checked;
  const log = document.getElementById('team-log');
  if (!passcode) return logEvent({ agent: 'system', kind: 'error', text: 'Enter the demo passcode first.' });
  localStorage.setItem('creator-escrow-passcode', passcode);
  log.innerHTML = '';
  button.disabled = true;
  button.textContent = 'Running…';
  logEvent({ agent: 'system', kind: 'say', text: dryRun ? 'Starting a dry run: nothing will be sent on chain.' : 'Starting a campaign cycle on Base Sepolia.' });
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode, dryRun }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(res.status === 401 ? 'Wrong passcode.' : `Server answered ${res.status} ${text.slice(0, 200)}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (value) buffer += value;
      const lines = buffer.split('\n');
      buffer = end ? '' : lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        logEvent(ev);
        if (ev.kind === 'done') done = ev.data ?? {};
      }
      if (end) break;
    }
    if (done && !done.dryRun && done.settleTx) {
      freshSettles.add(done.settleTx);
      logEvent({ agent: 'system', kind: 'say', text: 'Reloading the deals from chain…' });
      await renderDeals();
      document.getElementById('deals').scrollIntoView({ behavior: 'smooth' });
    }
  } catch (e) {
    logEvent({ agent: 'system', kind: 'error', text: e.message ?? String(e) });
  } finally {
    button.disabled = false;
    button.textContent = 'Run the agent team';
  }
}

document.getElementById('team-pass').value = localStorage.getItem('creator-escrow-passcode') ?? '';
document.getElementById('team-form').addEventListener('submit', runTeam);
