// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Test stablecoin for the PayOnProof demo
/// @notice Anyone can mint up to 100,000 per call. The aUSD faucet gives each account 10 aUSD in total, which is too
/// little for invoice-sized demos; the escrow works with any ERC-20, aUSD included.
contract DemoUSD is ERC20 {
    uint256 public constant MAX_MINT = 100_000e6;

    error MintTooLarge(uint256 amount);

    constructor() ERC20("Demo USD", "dUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge(amount);
        _mint(to, amount);
    }
}
