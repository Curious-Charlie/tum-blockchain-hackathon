/**
 * PayOnProof, single chain: the whole flow on Base Sepolia, no Cardano.
 *
 *   node src/payonproof/run.ts            # from api3/
 *
 * 1. Lena chooses a Keeper by its record on chain: InvoicePaid events with the Keeper as executor.
 * 2. Lena opens two orders on InvoiceEscrowV2, each locking the invoice at her limit plus the Keeper's fee:
 *    one with a limit above the live EUR/USD (it will pay), one below it (it will not, and expires).
 * 3. Keeper Swift polls Nodary's signed EUR/USD. When an order's condition holds, it first buys a second signed
 *    rate (Frankfurter, 0.01 aUSD over x402) and executes only if both agree within 1 %. One transaction pays the
 *    supplier, pays the Keeper its fee and refunds Lena.
 * 4. After the second order's deadline Lena cancels it and gets the deposit and the fee back.
 */
import { hexToString, parseEventLogs, stringToHex, type Address } from 'viem';
import {
  DUSD,
  ESCROW_V2,
  MAX_DEVIATION,
  STATUS,
  SUPPLIERS,
  SWIFT_KEY,
  addressLink,
  buySecondRate,
  client,
  confirm,
  escrowAbi,
  explainRevert,
  fetchSignedRate,
  lena,
  paidExecutions,
  showRate,
  swift,
  tokenAbi,
  toRate,
  txLink,
  usd,
} from './lib.ts';

const MIN_RECORD = 3; // paid executions on chain before Lena trusts a Keeper with an invoice
const FEE = 500_000n; // 0.50 dUSD
const POLL_MS = 20_000;
const log = (who: string, message: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${who.padEnd(12)} ${message}`);
const links: [string, string][] = [];

log('Setup', `InvoiceEscrowV2 ${addressLink(ESCROW_V2)}`);
log('Setup', `Lena ${lena.account.address}, Keeper Swift ${swift.account.address}`);

// 1. Lena chooses a Keeper by its record on chain.
const bids = [{ name: 'Keeper Swift', address: swift.account.address, fee: FEE }];
let keeper: (typeof bids)[number] | undefined;
for (const bid of bids) {
  const record = await paidExecutions(bid.address);
  const ok = record.total >= MIN_RECORD;
  log('Lena', `${bid.name} bids ${usd(bid.fee)} per execution; record on chain: ${record.total} InvoicePaid as executor (v1 ${record.v1}, v2 ${record.v2})${record.latest ? `, latest ${txLink(record.latest)}` : ''} → ${ok ? 'acceptable' : `needs ${MIN_RECORD}`}`);
  if (ok && (!keeper || bid.fee < keeper.fee)) keeper = bid;
}
if (!keeper) throw new Error('No Keeper with a record on chain');
log('Lena', `chooses ${keeper.name}; its fee is locked in the order and paid by the contract in the payment transaction`);

// 2. Two orders.
const live = await fetchSignedRate();
const above = Math.ceil((Number(live.display) + 0.005) * 100) / 100;
const below = Math.floor((Number(live.display) - 0.005) * 100) / 100;
log('Lena', `Nodary signed EUR/USD ${live.display} (signature checked off chain)`);

const allowance = await client.readContract({ address: DUSD, abi: tokenAbi, functionName: 'allowance', args: [lena.account.address, ESCROW_V2] });
if (allowance < 10n ** 12n) {
  const hash = await lena.writeContract({ address: DUSD, abi: tokenAbi, functionName: 'approve', args: [ESCROW_V2, 2n ** 255n] });
  await confirm(hash);
  log('Lena', `approves the escrow for dUSD ${txLink(hash)}`);
}

const now = Math.floor(Date.now() / 1000);
const plans = [
  { ref: 'INV-41', supplier: SUPPLIERS.cafeverde, cents: 250_00n, limit: above, deadline: BigInt(now + 86_400) },
  { ref: 'INV-42', supplier: SUPPLIERS.fazendaalta, cents: 180_00n, limit: below, deadline: BigInt(now + 180) },
];
const orders: { id: bigint; ref: string; supplier: { name: string; address: Address }; deadline: bigint }[] = [];
// An invoice that already has an open order from Lena keeps it (a rerun never locks the money twice).
const orderCount = await client.readContract({ address: ESCROW_V2, abi: escrowAbi, functionName: 'orderCount' });
const existing = new Map<string, bigint>();
for (let id = 1n; id <= orderCount; id++) {
  const order = await client.readContract({ address: ESCROW_V2, abi: escrowAbi, functionName: 'getOrder', args: [id] });
  if (order.payer === lena.account.address && STATUS[order.status] === 'Open' && order.deadline > BigInt(now + 60)) existing.set(hexToString(order.invoiceRef, { size: 32 }).replace(/\0+$/, ''), id);
}
for (const plan of plans) {
  const reuse = existing.get(plan.ref);
  if (reuse) {
    const order = await client.readContract({ address: ESCROW_V2, abi: escrowAbi, functionName: 'getOrder', args: [reuse] });
    orders.push({ id: reuse, ref: plan.ref, supplier: plan.supplier, deadline: order.deadline });
    log('Lena', `${plan.ref}: already open as order ${reuse} (EUR/USD < ${showRate(order.maxRate)}, ${usd(order.deposit)} + fee ${usd(order.keeperFee)} locked), keeping it`);
    continue;
  }
  const { request } = await client
    .simulateContract({
      account: lena.account,
      address: ESCROW_V2,
      abi: escrowAbi,
      functionName: 'createOrder',
      args: [stringToHex(plan.ref, { size: 32 }), plan.supplier.address, DUSD, plan.cents, toRate(plan.limit), plan.deadline, keeper.address, keeper.fee],
    })
    .catch(explainRevert);
  const hash = await lena.writeContract(request);
  const receipt = await confirm(hash);
  const [created] = parseEventLogs({ abi: escrowAbi, eventName: 'OrderCreated', logs: receipt.logs });
  orders.push({ id: created!.args.orderId, ref: plan.ref, supplier: plan.supplier, deadline: plan.deadline });
  links.push([`${plan.ref} created (order ${created!.args.orderId}): €${Number(plan.cents) / 100} to ${plan.supplier.name} when EUR/USD < ${plan.limit}, locks ${usd(created!.args.deposit)} + fee ${usd(created!.args.keeperFee)}`, txLink(hash)]);
  log('Lena', `${plan.ref}: order ${created!.args.orderId}, €${Number(plan.cents) / 100} to ${plan.supplier.name} when EUR/USD < ${plan.limit}, deadline ${plan.ref === 'INV-42' ? 'in 3 min' : 'in 24 h'}; locks ${usd(created!.args.deposit)} + fee ${usd(created!.args.keeperFee)} ${txLink(hash)}`);
}

// 3. Keeper Swift's loop.
const balance = (address: Address) => client.readContract({ address: DUSD, abi: tokenAbi, functionName: 'balanceOf', args: [address] });
const swiftBefore = await balance(swift.account.address);
for (let round = 1; ; round++) {
  const open = [];
  for (const o of orders) {
    const order = await client.readContract({ address: ESCROW_V2, abi: escrowAbi, functionName: 'getOrder', args: [o.id] });
    if (STATUS[order.status] === 'Open' && order.keeper === swift.account.address && BigInt(Math.floor(Date.now() / 1000)) <= order.deadline) open.push({ ...o, order });
  }
  if (!open.length) break;
  const signed = await fetchSignedRate();
  for (const { id, ref, order, supplier } of open) {
    if (signed.rate >= order.maxRate) {
      log('Swift', `round ${round}, ${ref}: signed EUR/USD ${signed.display} ≥ limit ${showRate(order.maxRate)}, waiting`);
      continue;
    }
    log('Swift', `round ${round}, ${ref}: signed EUR/USD ${signed.display} < limit ${showRate(order.maxRate)}; buying a second opinion over x402`);
    const second = await buySecondRate(SWIFT_KEY);
    const deviation = Math.abs(second.rate - Number(signed.display)) / Number(signed.display);
    log('Swift', `Frankfurter (signed, ${second.date}) says ${second.rate}: ${(deviation * 100).toFixed(2)} % apart${second.paymentTx ? `, paid 0.01 aUSD ${txLink(second.paymentTx)}` : ''}`);
    if (second.paymentTx) links.push(['Swift pays 0.01 aUSD over x402 for Frankfurter EUR/USD (cross-check)', txLink(second.paymentTx)]);
    if (deviation > MAX_DEVIATION) {
      log('Swift', `sources disagree by more than ${MAX_DEVIATION * 100} %, not executing`);
      continue;
    }
    const args = [id, BigInt(signed.signed.timestamp), stringToHex(signed.signed.data), signed.signed.signature] as const;
    const { request } = await client.simulateContract({ account: swift.account, address: ESCROW_V2, abi: escrowAbi, functionName: 'execute', args }).catch(explainRevert);
    const hash = await swift.writeContract(request);
    const receipt = await confirm(hash);
    const [paid] = parseEventLogs({ abi: escrowAbi, eventName: 'InvoicePaid', logs: receipt.logs });
    const a = paid!.args;
    log('Escrow', `${ref} PAID in one transaction at ${showRate(a.rate)}: ${usd(a.payout)} → ${supplier.name}, fee ${usd(a.keeperFee)} → Swift, ${usd(a.refund)} back to Lena ${txLink(hash)}`);
    links.push([`${ref} paid atomically: ${usd(a.payout)} to ${supplier.name}, ${usd(a.keeperFee)} fee to Keeper Swift, ${usd(a.refund)} refunded to Lena (EUR/USD ${showRate(a.rate)})`, txLink(hash)]);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

// 4. Lena cancels what did not pay by its deadline.
for (const o of orders) {
  const order = await client.readContract({ address: ESCROW_V2, abi: escrowAbi, functionName: 'getOrder', args: [o.id] });
  if (STATUS[order.status] !== 'Open') continue;
  const { request } = await client.simulateContract({ account: lena.account, address: ESCROW_V2, abi: escrowAbi, functionName: 'cancel', args: [o.id] }).catch(explainRevert);
  const hash = await lena.writeContract(request);
  const receipt = await confirm(hash);
  const [cancelled] = parseEventLogs({ abi: escrowAbi, eventName: 'OrderCancelled', logs: receipt.logs });
  log('Lena', `${o.ref} expired unpaid (EUR/USD never went below the limit); cancels and gets ${usd(cancelled!.args.refund)} back, fee included ${txLink(hash)}`);
  links.push([`${o.ref} cancelled after its deadline: ${usd(cancelled!.args.refund)} (deposit + fee) back to Lena`, txLink(hash)]);
}

log('Swift', `earned ${usd((await balance(swift.account.address)) - swiftBefore)} in fees this run`);
console.log('\nTransactions:');
for (const [what, link] of links) console.log(`- ${what}: ${link}`);
