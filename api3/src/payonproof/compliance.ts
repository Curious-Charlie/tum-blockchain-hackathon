/**
 * "Agent pays verified suppliers only" on Base Sepolia: CompliantInvoiceEscrow pays an invoice only with a fresh
 * Companies House response, signed by its Airnode, saying the supplier's company is active (plus v1's rate checks).
 *
 *   node src/payonproof/compliance.ts     # from api3/
 *
 * Lena's agent is told to pay two invoices and opens both orders, each bound to the supplier's company number:
 *   INV-51  company 02627406, active    → Keeper Swift executes: supplier and Keeper fee in one transaction
 *   INV-52  company 05514098, dissolved → Swift submits the genuine signed response anyway: the contract reverts
 * Before executing, four tampered company responses are dry-run against the deployed contract (no gas).
 */
import { readFileSync } from 'node:fs';
import { encodePacked, keccak256, parseEventLogs, stringToHex, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { companyRequestHash, fetchCompanyStatus } from './companies-house.ts';
import { DUSD, SWIFT_KEY, addressLink, client, confirm, explainRevert, fetchSignedRate, lena, showRate, swift, tokenAbi, toRate, txLink, usd } from './lib.ts';
import { parseAbi } from 'viem';

const ESCROW: Address = (process.env.COMPLIANT_ESCROW as Address | undefined) ?? '0xb975d0c7557098ca4d29aaf2c27817f37fcfcdba';
const abi = parseAbi([
  'struct Signed { uint256 timestamp; bytes data; bytes signature; }',
  'function createOrder(bytes32 invoiceRef, address payee, address token, uint256 amountEurCents, uint256 maxRate, uint64 deadline, address keeper, uint256 keeperFee, bytes32 companyRequestHash) returns (uint256 orderId)',
  'function execute(uint256 orderId, Signed fx, Signed company) returns (uint256 payout)',
  'function cancel(uint256 orderId)',
  'event OrderCreated(uint256 indexed orderId, address indexed payer, address indexed payee, bytes32 invoiceRef, bytes32 companyRequestHash, uint256 amountEurCents, uint256 maxRate, uint256 deposit, uint64 deadline, address keeper, uint256 keeperFee)',
  'event InvoicePaid(uint256 indexed orderId, address indexed executor, address indexed payee, uint256 rate, uint256 payout, uint256 keeperFee, uint256 refund)',
  'event ComplianceEvidence(uint256 indexed orderId, address fxSigner, bytes32 fxRequestHash, uint256 fxTimestamp, address companySigner, bytes32 companyRequestHash, uint256 companyTimestamp)',
  'event OrderCancelled(uint256 indexed orderId, uint256 refund)',
  'error InvalidOrder()',
  'error OrderNotOpen(uint256 orderId, uint8 status)',
  'error OrderExpired(uint256 orderId, uint64 deadline)',
  'error NotPayer(address caller)',
  'error KeeperOnly(address keeper, uint64 exclusiveUntil)',
  'error ResponseTooOld(address airnode, uint256 responseTimestamp)',
  'error RateTooOld(uint256 rateTimestamp)',
  'error ConditionNotMet(uint256 rate, uint256 maxRate)',
  'error CompanyNotActive(bytes data)',
  'error NotSignedByAirnode(address signer)',
  'error ECDSAInvalidSignature()',
  'error SafeERC20FailedOperation(address token)',
]);
interface Signed {
  timestamp: string;
  data: string;
  signature: Hex;
}
const asArg = (s: Signed) => ({ timestamp: BigInt(s.timestamp), data: toHex(s.data), signature: s.signature });
const log = (who: string, message: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${who.padEnd(8)} ${message}`);
const links: [string, string][] = [];
const FEE = 500_000n;

const supplierAddress = (companyNumber: string) => privateKeyToAddress(keccak256(stringToHex(`payonproof:supplier:uk-${companyNumber}`)));
const invoices = [
  { ref: 'INV-51', company: '02627406', cents: 120_00n },
  { ref: 'INV-52', company: '05514098', cents: 90_00n },
];

log('Setup', `CompliantInvoiceEscrow ${addressLink(ESCROW)}; Lena ${lena.account.address}, Keeper Swift ${swift.account.address}`);

// Lena's agent: approve once, then one order per invoice, each bound to the supplier's company number.
const allowance = await client.readContract({ address: DUSD, abi: tokenAbi, functionName: 'allowance', args: [lena.account.address, ESCROW] });
if (allowance < 10n ** 12n) {
  const hash = await lena.writeContract({ address: DUSD, abi: tokenAbi, functionName: 'approve', args: [ESCROW, 2n ** 255n] });
  await confirm(hash);
  log('Lena', `approves the escrow for dUSD ${txLink(hash)}`);
  links.push(['Lena approves the escrow for dUSD', txLink(hash)]);
}
const orders: { id: bigint; ref: string; company: string; requestHash: Hex }[] = [];
for (const inv of invoices) {
  const requestHash = companyRequestHash(inv.company);
  const { request } = await client
    .simulateContract({
      account: lena.account,
      address: ESCROW,
      abi,
      functionName: 'createOrder',
      args: [stringToHex(inv.ref, { size: 32 }), supplierAddress(inv.company), DUSD, inv.cents, toRate(1.13), BigInt(Math.floor(Date.now() / 1000) + 3600), swift.account.address, FEE, requestHash],
    })
    .catch(explainRevert);
  const hash = await lena.writeContract(request);
  const [created] = parseEventLogs({ abi, eventName: 'OrderCreated', logs: (await confirm(hash)).logs });
  orders.push({ id: created!.args.orderId, ref: inv.ref, company: inv.company, requestHash });
  const line = `${inv.ref} (order ${created!.args.orderId}): €${Number(inv.cents) / 100} to the supplier with UK company number ${inv.company}, when EUR/USD < 1.13; company request ${requestHash.slice(0, 10)}…; locks ${usd(created!.args.deposit)} + fee ${usd(created!.args.keeperFee)}`;
  log('Lena', `${line} ${txLink(hash)}`);
  links.push([line, txLink(hash)]);
}
const [a, b] = orders as [(typeof orders)[number], (typeof orders)[number]];

// Keeper Swift: buys the signed company status (0.01 aUSD each over x402) and the signed rate, right before executing.
for (const o of orders) if (companyRequestHash(o.company) !== o.requestHash) throw new Error(`${o.ref}: company number does not match the order`);
const [fx, statusA, statusB] = await Promise.all([fetchSignedRate(), fetchCompanyStatus(a.company, SWIFT_KEY), fetchCompanyStatus(b.company, SWIFT_KEY)]);
log('Swift', `Nodary EUR/USD ${fx.display}; Companies House (signed, paid over x402): ${a.company} ${statusA.signed.data}, ${b.company} ${statusB.signed.data}`);
for (const [n, s] of [[a.company, statusA], [b.company, statusB]] as const) if (s.paymentTx) links.push([`Swift pays 0.01 aUSD over x402 for Companies House ${n}`, txLink(s.paymentTx)]);

// Tamper test on the company response: dry runs from Swift's account against the deployed contract.
const simulate = (orderId: bigint, company: Signed) =>
  client.simulateContract({ account: swift.account, address: ESCROW, abi, functionName: 'execute', args: [orderId, asArg(fx.signed), asArg(company)] }).then(
    () => undefined,
    (error) => {
      try {
        explainRevert(error);
      } catch (e) {
        return (e as Error).message;
      }
    },
  );
const stale = JSON.parse(readFileSync(new URL('../../test/fixtures/companies-house-02627406.json', import.meta.url), 'utf8')) as Signed;
const impostor = privateKeyToAccount(generatePrivateKey());
const activeData = '{"status":"active"}';
const digest = keccak256(encodePacked(['bytes32', 'uint256', 'bytes'], [b.requestHash, BigInt(statusB.signed.timestamp), toHex(activeData)]));
const cases: [string, bigint, Signed][] = [
  [`1 · ${b.ref}: the dissolved company's real response, edited to ${activeData}`, b.id, { ...statusB.signed, data: activeData }],
  [`2 · ${a.ref}: a real "active" response for ${a.company}, signed ${new Date(Number(stale.timestamp) * 1000).toISOString().slice(11, 19)} UTC (older than 2 minutes)`, a.id, stale],
  [`3 · ${b.ref}: a real, fresh "active" response for another company (${a.company})`, b.id, statusA.signed],
  [`4 · ${b.ref}: ${activeData} signed by another key (${impostor.address})`, b.id, { timestamp: statusB.signed.timestamp, data: activeData, signature: await impostor.signMessage({ message: { raw: digest } }) }],
];
let failures = 0;
for (const [label, id, response] of cases) {
  const error = await simulate(id, response);
  if (!error) failures++;
  log('Tamper', `${error ? 'REJECTED' : 'NOT REJECTED (bug!)'} ${label}${error ? `: ${error}` : ''}`);
}

// INV-51: active company, valid responses → paid.
{
  const { request } = await client.simulateContract({ account: swift.account, address: ESCROW, abi, functionName: 'execute', args: [a.id, asArg(fx.signed), asArg(statusA.signed)] }).catch(explainRevert);
  const hash = await swift.writeContract(request);
  const logs = (await confirm(hash)).logs;
  const [paid] = parseEventLogs({ abi, eventName: 'InvoicePaid', logs });
  const [evidence] = parseEventLogs({ abi, eventName: 'ComplianceEvidence', logs });
  const p = paid!.args;
  const line = `${a.ref} PAID in one transaction at ${showRate(p.rate)}: ${usd(p.payout)} → supplier ${a.company}, fee ${usd(p.keeperFee)} → Swift, ${usd(p.refund)} → Lena; ComplianceEvidence: Companies House ${evidence!.args.companySigner.slice(0, 10)}… request ${evidence!.args.companyRequestHash.slice(0, 10)}… signed at ${evidence!.args.companyTimestamp}, Nodary signed at ${evidence!.args.fxTimestamp}`;
  log('Escrow', `${line} ${txLink(hash)}`);
  links.push([line, txLink(hash)]);
}

// INV-52: the agent was told to pay it too. The genuine signed "dissolved" response goes on chain and the contract refuses.
{
  const reason = await simulate(b.id, statusB.signed);
  log('Swift', `${b.ref}: submitting the genuine signed response ${statusB.signed.data} (dry run says ${reason ?? 'it would pass!'})`);
  const hash = await swift.writeContract({ address: ESCROW, abi, functionName: 'execute', args: [b.id, asArg(fx.signed), asArg(statusB.signed)], gas: 300_000n });
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 2_000, timeout: 180_000 });
  if (receipt.status !== 'reverted' || !reason) failures++;
  const line = `${b.ref} REJECTED on chain (${receipt.status}): ${reason}`;
  log('Escrow', `${line} ${txLink(hash)}`);
  links.push([line, txLink(hash)]);

  const cancel = await client.simulateContract({ account: lena.account, address: ESCROW, abi, functionName: 'cancel', args: [b.id] }).catch(explainRevert);
  const cancelHash = await lena.writeContract(cancel.request);
  const [cancelled] = parseEventLogs({ abi, eventName: 'OrderCancelled', logs: (await confirm(cancelHash)).logs });
  const cline = `${b.ref} cancelled: ${usd(cancelled!.args.refund)} (deposit + fee) back to Lena`;
  log('Lena', `${cline} ${txLink(cancelHash)}`);
  links.push([cline, txLink(cancelHash)]);
}

console.log('\nTransactions:');
for (const [what, link] of links) console.log(`- ${what}: ${link}`);
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks behaved as expected.');
process.exitCode = failures ? 1 : 0;
