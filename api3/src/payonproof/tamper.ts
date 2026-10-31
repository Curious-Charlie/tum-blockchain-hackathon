/**
 * API3 tamper test against InvoiceEscrowV2 on Base Sepolia: four tampered responses are rejected by the contract
 * itself (dry runs with eth_call from the Keeper's account, so they cost no gas), then the valid, fresh response
 * executes the order and pays the supplier and the Keeper's fee in one transaction.
 *
 *   node src/payonproof/tamper.ts         # from api3/
 */
import { readFileSync } from 'node:fs';
import { encodePacked, keccak256, parseEventLogs, stringToHex, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  DUSD,
  ESCROW_V2,
  EUR_USD_REQUEST_HASH,
  SUPPLIERS,
  addressLink,
  client,
  confirm,
  escrowAbi,
  explainRevert,
  fetchSignedFeed,
  fetchSignedRate,
  lena,
  showRate,
  swift,
  toRate,
  txLink,
  usd,
} from './lib.ts';

interface Response {
  timestamp: string;
  data: string;
  signature: Hex;
}

const live = await fetchSignedRate();
const limit = Math.ceil((Number(live.display) + 0.01) * 100) / 100;
console.log(`Tamper test on InvoiceEscrowV2 ${addressLink(ESCROW_V2)}`);
console.log(`Live Nodary EUR/USD ${live.display}; opening a €100 order that pays when EUR/USD < ${limit}, Keeper Swift, fee 0.10 dUSD`);

const { request } = await client
  .simulateContract({
    account: lena.account,
    address: ESCROW_V2,
    abi: escrowAbi,
    functionName: 'createOrder',
    args: [stringToHex('TAMPER-TEST-V2', { size: 32 }), SUPPLIERS.cafeverde.address, DUSD, 100_00n, toRate(limit), BigInt(Math.floor(Date.now() / 1000) + 86_400), swift.account.address, 100_000n],
  })
  .catch(explainRevert);
const createHash = await lena.writeContract(request);
const [created] = parseEventLogs({ abi: escrowAbi, eventName: 'OrderCreated', logs: (await confirm(createHash)).logs });
const orderId = created!.args.orderId;
console.log(`Order ${orderId} locks ${usd(created!.args.deposit)} + fee ${usd(created!.args.keeperFee)} ${txLink(createHash)}\n`);

const digest = (timestamp: string, data: string) => keccak256(encodePacked(['bytes32', 'uint256', 'bytes'], [EUR_USD_REQUEST_HASH, BigInt(timestamp), toHex(data)]));
const editedPrice = (data: string) => data.replace(/"price":([\d.]+)/, (_m, p: string) => `"price":${(Number(p) - 0.1).toFixed(4)}`);
const impostor = privateKeyToAccount(generatePrivateKey());
const forgedData = editedPrice(live.signed.data);
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/nodary-eur-usd.json', import.meta.url), 'utf8')) as Response;

const simulate = (response: Response, account: Address = swift.account.address) =>
  client
    .simulateContract({ account, address: ESCROW_V2, abi: escrowAbi, functionName: 'execute', args: [orderId, BigInt(response.timestamp), toHex(response.data), response.signature] })
    .then(
      () => undefined,
      (error) => {
        try {
          explainRevert(error);
        } catch (e) {
          return (e as Error).message;
        }
      },
    );

const cases: [string, Response][] = [
  [`1 · real response, one value edited (${editedPrice(live.signed.data)})`, { ...live.signed, data: editedPrice(live.signed.data) }],
  [`2 · real response, too old (signed ${new Date(Number(fixture.timestamp) * 1000).toISOString().slice(0, 16)}Z, the limit is 2 minutes)`, fixture],
  ['3 · real, fresh response to another request (Nodary BTC/USD)', await fetchSignedFeed('BTC/USD')],
  [`4 · signed by another key (${impostor.address})`, { timestamp: live.signed.timestamp, data: forgedData, signature: await impostor.signMessage({ message: { raw: digest(live.signed.timestamp, forgedData) } }) }],
];
let failures = 0;
for (const [label, response] of cases) {
  const error = await simulate(response);
  if (!error) failures++;
  console.log(`${error ? 'REJECTED' : 'NOT REJECTED (bug!)'}  ${label}${error ? `: ${error}` : ''}`);
}
// Not a tampered response: the valid one, from someone other than the chosen Keeper, inside the exclusive period.
const outsider = await simulate(live.signed, lena.account.address);
console.log(`${outsider ? 'REJECTED' : 'NOT REJECTED (bug!)'}  valid response, but submitted by someone other than Keeper Swift during its 10-minute exclusive period${outsider ? `: ${outsider}` : ''}`);
if (!outsider) failures++;

const fresh = await fetchSignedRate();
const exec = await client
  .simulateContract({ account: swift.account, address: ESCROW_V2, abi: escrowAbi, functionName: 'execute', args: [orderId, BigInt(fresh.signed.timestamp), toHex(fresh.signed.data), fresh.signed.signature] })
  .catch(explainRevert);
const hash = await swift.writeContract(exec.request);
const [paid] = parseEventLogs({ abi: escrowAbi, eventName: 'InvoicePaid', logs: (await confirm(hash)).logs });
const a = paid!.args;
console.log(`ACCEPTED  the valid, fresh response from Keeper Swift (EUR/USD ${showRate(a.rate)}): ${usd(a.payout)} to the supplier, ${usd(a.keeperFee)} fee to Swift, ${usd(a.refund)} back to Lena ${txLink(hash)}`);
console.log(failures ? `\n${failures} case(s) were not rejected` : '\nTamper test passed: every tampered response was rejected and the valid one executed.');
process.exitCode = failures ? 1 : 0;
