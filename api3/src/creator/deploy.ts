// Deploys CreatorDealEscrow, trusting the TwitterAPI.io Airnode, from the brand's account. Run `forge build` first.
import { confirm, ESCROW_ABI, ESCROW_BYTECODE, brandKey, walletFor, writeDeployment } from './chain.ts';
import { TWITTERAPI_AIRNODE_V2_ADDRESS } from './twitter.ts';

const wallet = walletFor(brandKey());
const hash = await wallet.deployContract({
  abi: ESCROW_ABI,
  bytecode: ESCROW_BYTECODE,
  args: [TWITTERAPI_AIRNODE_V2_ADDRESS],
});
const receipt = await confirm(hash, 'deploy CreatorDealEscrow');
writeDeployment({ escrow: receipt.contractAddress!, deployTx: hash });
console.log(`escrow at https://sepolia.basescan.org/address/${receipt.contractAddress}`);
