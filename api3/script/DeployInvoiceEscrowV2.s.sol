// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {InvoiceEscrowV2} from "../contracts/payonproof/InvoiceEscrowV2.sol";

/// forge script script/DeployInvoiceEscrowV2.s.sol --rpc-url $RPC_URL --broadcast
/// Reuses the DemoUSD token of the v1 deployment; only the escrow is new.
contract DeployInvoiceEscrowV2 is Script {
    /// `pnpm --silent request-hash EUR/USD`: Nodary latestFeeds EUR/USD, projected to {"price","updatedAt"}
    bytes32 constant EUR_USD_REQUEST_HASH = 0x5ccc3aa98c84e0929a84c28f3fe16c2a89b2e58965b487b5580af40be401d3d0;

    function run() external returns (InvoiceEscrowV2 escrow) {
        uint256 maxRateAge = vm.envOr("MAX_RATE_AGE", uint256(3 days));
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        escrow = new InvoiceEscrowV2(EUR_USD_REQUEST_HASH, maxRateAge);
        vm.stopBroadcast();
        console.log("InvoiceEscrowV2", address(escrow));
    }
}
