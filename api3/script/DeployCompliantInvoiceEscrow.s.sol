// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CompliantInvoiceEscrow} from "../contracts/payonproof/CompliantInvoiceEscrow.sol";

/// forge script script/DeployCompliantInvoiceEscrow.s.sol --rpc-url $RPC_URL --broadcast
contract DeployCompliantInvoiceEscrow is Script {
    /// `pnpm --silent request-hash EUR/USD`: Nodary latestFeeds EUR/USD, projected to {"price","updatedAt"}
    bytes32 constant EUR_USD_REQUEST_HASH = 0x5ccc3aa98c84e0929a84c28f3fe16c2a89b2e58965b487b5580af40be401d3d0;

    function run() external returns (CompliantInvoiceEscrow escrow) {
        uint256 maxRateAge = vm.envOr("MAX_RATE_AGE", uint256(3 days));
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        escrow = new CompliantInvoiceEscrow(EUR_USD_REQUEST_HASH, maxRateAge);
        vm.stopBroadcast();
        console.log("CompliantInvoiceEscrow", address(escrow));
    }
}
