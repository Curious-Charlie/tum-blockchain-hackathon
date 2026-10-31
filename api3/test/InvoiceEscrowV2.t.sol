// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AirnodeV2Attestation} from "../contracts/AirnodeV2Attestation.sol";
import {DemoUSD} from "../contracts/payonproof/DemoUSD.sol";
import {InvoiceEscrowV2} from "../contracts/payonproof/InvoiceEscrowV2.sol";
import {AirnodeV2Test} from "./utils/AirnodeV2Test.sol";

contract InvoiceEscrowV2Test is AirnodeV2Test {
    struct SignedResponse {
        bytes32 requestHash;
        uint256 timestamp;
        bytes data;
        bytes signature;
    }

    // A real Nodary response: {"price":1.1204,"updatedAt":1793355616924}
    SignedResponse eurUsd;
    InvoiceEscrowV2 escrow;
    DemoUSD usd;

    address lena = makeAddr("lena");
    address cafeVerde = makeAddr("cafeVerde");
    address keeper = makeAddr("keeper");
    address stranger = makeAddr("stranger");

    uint256 constant INVOICE_CENTS = 1_000_00; // EUR 1,000.00
    uint256 constant FEE = 2e6; // 2 dUSD
    uint64 deadline;

    function setUp() public {
        eurUsd = readFixture("nodary-eur-usd.json");
        escrow = new InvoiceEscrowV2(eurUsd.requestHash, 3 days);
        usd = new DemoUSD();
        vm.warp(eurUsd.timestamp + 10);
        deadline = uint64(block.timestamp + 14 days);

        usd.mint(lena, 10_000e6);
        vm.prank(lena);
        usd.approve(address(escrow), type(uint256).max);
    }

    function test_PaysTheInvoiceAndTheKeeperFeeInOneTransaction() public {
        uint256 id = createOrder(1.13e18);
        assertEq(usd.balanceOf(address(escrow)), 1_130e6 + FEE, "locks the invoice at the limit rate plus the fee");

        vm.expectEmit(address(escrow));
        emit InvoiceEscrowV2.InvoicePaid(
            id, keeper, cafeVerde, eurUsd.requestHash, eurUsd.timestamp, 1.1204e18, 1793355616, 1_120.4e6, FEE, 9.6e6
        );
        vm.prank(keeper);
        uint256 payout = submit(id, eurUsd);

        assertEq(payout, 1_120.4e6);
        assertEq(usd.balanceOf(cafeVerde), 1_120.4e6, "payee gets EUR 1,000 at 1.1204");
        assertEq(usd.balanceOf(keeper), FEE, "keeper gets its fee in the same transaction");
        assertEq(usd.balanceOf(lena), 10_000e6 - 1_120.4e6 - FEE, "payer gets the rest back");
        assertEq(usd.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.getOrder(id).status), uint8(InvoiceEscrowV2.Status.Paid));
    }

    function test_OnlyTheKeeperDuringTheExclusivePeriod() public {
        uint256 id = createOrder(1.13e18);
        uint64 exclusiveUntil = escrow.getOrder(id).exclusiveUntil;
        assertEq(exclusiveUntil, block.timestamp + 10 minutes);

        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrowV2.KeeperOnly.selector, keeper, exclusiveUntil));
        vm.prank(stranger);
        submit(id, eurUsd);

        // The chosen Keeper may execute right away.
        vm.prank(keeper);
        submit(id, eurUsd);
        assertEq(usd.balanceOf(keeper), FEE);
    }

    function test_AnyoneCanExecuteAfterTheExclusivePeriod() public {
        // Open the order 10 minutes before the fixture was signed, so the response is fresh when the period ends.
        vm.warp(eurUsd.timestamp - 10 minutes);
        uint256 id = createOrder(1.13e18);
        vm.warp(eurUsd.timestamp + 10);

        vm.prank(stranger);
        submit(id, eurUsd);
        assertEq(usd.balanceOf(stranger), FEE, "the fallback executor earns the fee");
        assertEq(usd.balanceOf(keeper), 0);
        assertEq(usd.balanceOf(cafeVerde), 1_120.4e6);
    }

    function test_RevertWhen_TheRateIsNotBelowTheLimit() public {
        uint256 id = createOrder(1.11e18);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrowV2.ConditionNotMet.selector, 1.1204e18, 1.11e18));
        vm.prank(keeper);
        submit(id, eurUsd);
    }

    // The tamper test from the hackathon brief.

    function test_RevertWhen_AValueIsEdited() public {
        uint256 id = createOrder(1.13e18);
        SignedResponse memory edited = eurUsd;
        edited.data = '{"price":1.0204,"updatedAt":1793355616924}';

        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        vm.prank(keeper);
        submit(id, edited);
    }

    function test_RevertWhen_TheResponseIsTooOld() public {
        uint256 id = createOrder(1.13e18);
        vm.warp(eurUsd.timestamp + 2 minutes + 1);

        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrowV2.ResponseTooOld.selector, eurUsd.timestamp));
        vm.prank(keeper);
        submit(id, eurUsd);
    }

    function test_RevertWhen_TheResponseAnswersAnotherRequest() public {
        SignedResponse memory btcUsd = readFixture("nodary-btc-usd.json");
        vm.warp(btcUsd.timestamp + 10);
        uint256 id = createOrder(1.13e18);

        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        vm.prank(keeper);
        submit(id, btcUsd);
    }

    function test_RevertWhen_AnotherKeySigned() public {
        uint256 id = createOrder(1.13e18);
        (address impostor, uint256 impostorKey) = makeAddrAndKey("impostor");
        SignedResponse memory forged = eurUsd;
        forged.data = '{"price":1.0001,"updatedAt":1793355616924}';
        forged.signature = signResponse(impostorKey, eurUsd.requestHash, eurUsd.timestamp, forged.data);

        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, impostor));
        vm.prank(keeper);
        submit(id, forged);
    }

    function test_RevertWhen_ExecutedTwice() public {
        uint256 id = createOrder(1.13e18);
        vm.startPrank(keeper);
        submit(id, eurUsd);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrowV2.OrderNotOpen.selector, id, InvoiceEscrowV2.Status.Paid));
        submit(id, eurUsd);
        vm.stopPrank();
    }

    function test_RevertWhen_TheOrderExpired() public {
        deadline = uint64(block.timestamp + 1);
        uint256 id = createOrder(1.13e18);
        vm.warp(block.timestamp + 2);

        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrowV2.OrderExpired.selector, id, deadline));
        vm.prank(keeper);
        submit(id, eurUsd);
    }

    function test_PayerCancelsAndGetsTheDepositAndTheFeeBack() public {
        uint256 id = createOrder(1.13e18);

        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrowV2.NotPayer.selector, keeper));
        vm.prank(keeper);
        escrow.cancel(id);

        vm.expectEmit(address(escrow));
        emit InvoiceEscrowV2.OrderCancelled(id, 1_130e6 + FEE);
        vm.prank(lena);
        escrow.cancel(id);
        assertEq(usd.balanceOf(lena), 10_000e6);
        assertEq(usd.balanceOf(address(escrow)), 0);

        vm.expectRevert(
            abi.encodeWithSelector(InvoiceEscrowV2.OrderNotOpen.selector, id, InvoiceEscrowV2.Status.Cancelled)
        );
        vm.prank(keeper);
        submit(id, eurUsd);
    }

    function test_RevertWhen_TheOrderIsInvalid() public {
        vm.startPrank(lena);
        vm.expectRevert(InvoiceEscrowV2.InvalidOrder.selector);
        escrow.createOrder("INV-1", address(0), usd, INVOICE_CENTS, 1.13e18, deadline, keeper, FEE);
        vm.expectRevert(InvoiceEscrowV2.InvalidOrder.selector);
        escrow.createOrder("INV-1", cafeVerde, usd, INVOICE_CENTS, 1.13e18, deadline, address(0), FEE);
        vm.expectRevert(InvoiceEscrowV2.InvalidOrder.selector);
        escrow.createOrder("INV-1", cafeVerde, usd, INVOICE_CENTS, 1.13e18, uint64(block.timestamp), keeper, FEE);
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
        return escrow.createOrder(
            "INV-17", cafeVerde, IERC20(address(usd)), INVOICE_CENTS, maxRate, deadline, keeper, FEE
        );
    }

    function submit(uint256 id, SignedResponse memory response) private returns (uint256) {
        return escrow.execute(id, response.timestamp, response.data, response.signature);
    }

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
