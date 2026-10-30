// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AirnodeV2Attestation} from "../contracts/AirnodeV2Attestation.sol";
import {DemoUSD} from "../contracts/payonproof/DemoUSD.sol";
import {InvoiceEscrow} from "../contracts/payonproof/InvoiceEscrow.sol";
import {AirnodeV2Test} from "./utils/AirnodeV2Test.sol";

contract InvoiceEscrowTest is AirnodeV2Test {
    struct SignedResponse {
        bytes32 requestHash;
        uint256 timestamp;
        bytes data;
        bytes signature;
    }

    // A real Nodary response: {"price":1.1204,"updatedAt":1793355616924}
    SignedResponse eurUsd;
    InvoiceEscrow escrow;
    DemoUSD usd;

    address lena = makeAddr("lena");
    address cafeVerde = makeAddr("cafeVerde");
    address keeper = makeAddr("keeper");

    uint256 constant INVOICE_CENTS = 1_000_00; // EUR 1,000.00
    uint64 deadline;

    function setUp() public {
        eurUsd = readFixture("nodary-eur-usd.json");
        escrow = new InvoiceEscrow(eurUsd.requestHash, 3 days);
        usd = new DemoUSD();
        vm.warp(eurUsd.timestamp + 10);
        deadline = uint64(block.timestamp + 14 days);

        usd.mint(lena, 10_000e6);
        vm.prank(lena);
        usd.approve(address(escrow), type(uint256).max);
    }

    function test_PaysTheInvoiceAtTheSignedRate() public {
        uint256 id = createOrder(1.13e18); // pay when EUR/USD < 1.13
        assertEq(usd.balanceOf(address(escrow)), 1_130e6, "locks the invoice at the limit rate");

        vm.expectEmit(address(escrow));
        emit InvoiceEscrow.InvoicePaid(id, keeper, 1.1204e18, 1793355616, 1_120.4e6, 9.6e6);
        vm.prank(keeper); // anyone can execute; the keeper never touches the money
        uint256 payout = submit(id, eurUsd);

        assertEq(payout, 1_120.4e6);
        assertEq(usd.balanceOf(cafeVerde), 1_120.4e6, "payee gets EUR 1,000 at 1.1204");
        assertEq(usd.balanceOf(lena), 10_000e6 - 1_120.4e6, "payer gets the rest back");
        assertEq(usd.balanceOf(keeper), 0);
        assertEq(usd.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.getOrder(id).status), uint8(InvoiceEscrow.Status.Paid));
    }

    function test_RevertWhen_TheRateIsNotBelowTheLimit() public {
        uint256 id = createOrder(1.11e18);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.ConditionNotMet.selector, 1.1204e18, 1.11e18));
        submit(id, eurUsd);

        id = createOrder(1.1204e18); // strictly below
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.ConditionNotMet.selector, 1.1204e18, 1.1204e18));
        submit(id, eurUsd);
    }

    // The next four tests are the tamper test from the hackathon brief.

    function test_RevertWhen_AValueIsEdited() public {
        uint256 id = createOrder(1.13e18);
        SignedResponse memory edited = eurUsd;
        edited.data = '{"price":1.0204,"updatedAt":1793355616924}';

        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        submit(id, edited);
    }

    function test_RevertWhen_TheResponseIsTooOld() public {
        uint256 id = createOrder(1.13e18);
        vm.warp(eurUsd.timestamp + escrow.MAX_RESPONSE_AGE() + 1);

        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.ResponseTooOld.selector, eurUsd.timestamp));
        submit(id, eurUsd);
    }

    function test_RevertWhen_TheResponseAnswersAnotherRequest() public {
        uint256 id = createOrder(1.13e18);
        // A real, fresh-looking Nodary response, but for BTC/USD
        SignedResponse memory btcUsd = readFixture("nodary-btc-usd.json");
        vm.warp(btcUsd.timestamp + 10);

        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        submit(id, btcUsd);
    }

    function test_RevertWhen_AnotherKeySigned() public {
        uint256 id = createOrder(1.13e18);
        (address impostor, uint256 impostorKey) = makeAddrAndKey("impostor");
        SignedResponse memory forged = eurUsd;
        forged.data = '{"price":1.0001,"updatedAt":1793355616924}';
        forged.signature = signResponse(impostorKey, eurUsd.requestHash, eurUsd.timestamp, forged.data);

        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, impostor));
        submit(id, forged);
    }

    function test_RevertWhen_TheRateIsTooOld() public {
        // The response is fresh, but Nodary took the rate 49 s before the Airnode signed it.
        escrow = new InvoiceEscrow(eurUsd.requestHash, 30 seconds);
        vm.prank(lena);
        usd.approve(address(escrow), type(uint256).max);
        uint256 id = createOrder(1.13e18);

        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.RateTooOld.selector, 1793355616));
        submit(id, eurUsd);
    }

    function test_RevertWhen_ExecutedTwice() public {
        uint256 id = createOrder(1.13e18);
        submit(id, eurUsd);

        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.OrderNotOpen.selector, id, InvoiceEscrow.Status.Paid));
        submit(id, eurUsd);
    }

    function test_RevertWhen_TheOrderExpired() public {
        deadline = uint64(block.timestamp + 1);
        uint256 id = createOrder(1.13e18);
        vm.warp(block.timestamp + 2);

        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.OrderExpired.selector, id, deadline));
        submit(id, eurUsd);
    }

    function test_PayerCanCancelAndGetsTheDepositBack() public {
        uint256 id = createOrder(1.13e18);

        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.NotPayer.selector, keeper));
        vm.prank(keeper);
        escrow.cancel(id);

        vm.prank(lena);
        escrow.cancel(id);
        assertEq(usd.balanceOf(lena), 10_000e6);

        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.OrderNotOpen.selector, id, InvoiceEscrow.Status.Cancelled));
        submit(id, eurUsd);
    }

    function test_RevertWhen_TheOrderIsInvalid() public {
        vm.startPrank(lena);
        vm.expectRevert(InvoiceEscrow.InvalidOrder.selector);
        escrow.createOrder("INV-1", address(0), usd, INVOICE_CENTS, 1.13e18, deadline);
        vm.expectRevert(InvoiceEscrow.InvalidOrder.selector);
        escrow.createOrder("INV-1", cafeVerde, usd, INVOICE_CENTS, 1.13e18, uint64(block.timestamp));
        vm.stopPrank();
    }

    function testFuzz_PayoutNeverExceedsTheDeposit(uint256 cents, uint256 maxRate, uint256 rate) public view {
        cents = bound(cents, 1, 1e12);
        maxRate = bound(maxRate, 2, 10e18);
        rate = bound(rate, 1, maxRate - 1);
        assertLe(escrow.quote(usd, cents, rate), escrow.quote(usd, cents, maxRate));
    }

    function createOrder(uint256 maxRate) private returns (uint256) {
        vm.prank(lena);
        return escrow.createOrder("INV-17", cafeVerde, IERC20(address(usd)), INVOICE_CENTS, maxRate, deadline);
    }

    function submit(uint256 id, SignedResponse memory response) private returns (uint256) {
        return escrow.execute(id, response.timestamp, response.data, response.signature);
    }

    // Reads a response that `pnpm --silent fetch-response <feed name>` saved.
    function readFixture(string memory name) private view returns (SignedResponse memory) {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(string.concat("test/fixtures/", name));
        return SignedResponse({
            requestHash: vm.parseJsonBytes32(json, ".requestHash"),
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });
    }
}
