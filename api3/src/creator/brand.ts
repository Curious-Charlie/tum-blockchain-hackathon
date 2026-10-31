// The brand opens a deal: mints its dUSD budget, approves the escrow, and locks maxPayout + settlerFee.
// Usage: brand.ts <creatorHandle> <code> <notBefore ISO> <holdSeconds> <minViews> <dUSD per 1000 views> <max dUSD> <fee dUSD> <days>
import { parseEventLogs, parseUnits } from 'viem';
import {
  brandKey,
  confirm,
  creatorAddress,
  DUSD,
  DUSD_ABI,
  ESCROW_ABI,
  publicClient,
  readDeployment,
  walletFor,
} from './chain.ts';

const [handle, code, notBeforeIso, hold, minViews, perK, max, fee, days] = process.argv.slice(2) as string[];
if (!handle || !code || !notBeforeIso || !hold || !minViews || !perK || !max || !fee || !days)
  throw new Error('Missing arguments');
const { escrow } = readDeployment();
const wallet = walletFor(brandKey());
const brand = wallet.account.address;
const maxPayout = parseUnits(max, 6);
const settlerFee = parseUnits(fee, 6);
const deposit = maxPayout + settlerFee;

if (
  (await publicClient.readContract({ address: DUSD, abi: DUSD_ABI, functionName: 'balanceOf', args: [brand] })) <
  deposit
)
  await confirm(
    await wallet.writeContract({ address: DUSD, abi: DUSD_ABI, functionName: 'mint', args: [brand, deposit] }),
    'mint dUSD'
  );
if (
  (await publicClient.readContract({
    address: DUSD,
    abi: DUSD_ABI,
    functionName: 'allowance',
    args: [brand, escrow],
  })) < deposit
)
  await confirm(
    await wallet.writeContract({ address: DUSD, abi: DUSD_ABI, functionName: 'approve', args: [escrow, 10n ** 12n] }),
    'approve escrow'
  );

const terms = {
  token: DUSD,
  creatorPayee: creatorAddress(),
  creatorHandle: handle,
  code,
  notBefore: BigInt(Math.floor(Date.parse(notBeforeIso) / 1000)),
  holdSeconds: BigInt(hold),
  deadline: BigInt(Math.floor(Date.now() / 1000) + Number(days) * 86400),
  minViews: BigInt(minViews),
  payPerKViews: parseUnits(perK, 6),
  maxPayout,
  settlerFee,
};
const receipt = await confirm(
  await wallet.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: 'createDeal', args: [terms] }),
  'createDeal'
);
const [created] = parseEventLogs({ abi: ESCROW_ABI, logs: receipt.logs, eventName: 'DealCreated' });
console.log(
  'deal',
  (created?.args as { dealId: bigint } | undefined)?.dealId,
  'for @' + handle,
  'code',
  code,
  'payee',
  terms.creatorPayee
);
