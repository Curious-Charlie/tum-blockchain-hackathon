// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AirnodeV2Attestation} from "../contracts/AirnodeV2Attestation.sol";
import {DemoUSD} from "../contracts/payonproof/DemoUSD.sol";
import {CompliantInvoiceEscrow} from "../contracts/payonproof/CompliantInvoiceEscrow.sol";
import {AirnodeV2Test} from "./utils/AirnodeV2Test.sol";

/// Real responses, fetched together on Sat 2026-10-31: Nodary EUR/USD {"price":1.116325,...} and Companies House
/// getCompanyProfile projected to {"status":...} for 02627406 (active), 00445790 (active) and 05514098 (dissolved).
contract CompliantInvoiceEscrowTest is AirnodeV2Test {
    struct Response {
        bytes32 requestHash;
        uint256 timestamp;
        bytes data;
        bytes signature;
    }

    Response fx;
    Response active; // 02627406
    Response otherActive; // 00445790
    Response dissolved; // 05514098

    CompliantInvoiceEscrow escrow;
    DemoUSD usd;
    address lena = makeAddr("lena");
    address supplier = makeAddr("supplier");
    address keeper = makeAddr("keeper");
    address stranger = makeAddr("stranger");
    uint256 constant CENTS = 1_000_00;
    uint256 constant FEE = 2e6;

    function setUp() public {
        fx = readFixture("nodary-eur-usd-2.json");
        active = readFixture("companies-house-02627406.json");
        otherActive = readFixture("companies-house-00445790.json");
        dissolved = readFixture("companies-house-05514098.json");
        escrow = new CompliantInvoiceEscrow(fx.requestHash, 3 days);
        usd = new DemoUSD();
        vm.warp(active.timestamp + 10);
        usd.mint(lena, 10_000e6);
        vm.prank(lena);
        usd.approve(address(escrow), type(uint256).max);
    }

    function test_PaysAVerifiedSupplierAndTheKeeperInOneTransaction() public {
        uint256 id = createOrder(active.requestHash);

        vm.expectEmit(address(escrow));
        emit CompliantInvoiceEscrow.InvoicePaid(id, keeper, supplier, 1.116325e18, 1_116.325e6, FEE, 13.675e6);
        vm.expectEmit(address(escrow));
        emit CompliantInvoiceEscrow.ComplianceEvidence(
            id,
            escrow.NODARY(),
            fx.requestHash,
            fx.timestamp,
            escrow.COMPANIES_HOUSE(),
            active.requestHash,
            active.timestamp
        );
        vm.prank(keeper);
        submit(id, fx, active);

        assertEq(usd.balanceOf(supplier), 1_116.325e6);
        assertEq(usd.balanceOf(keeper), FEE);
        assertEq(usd.balanceOf(lena), 10_000e6 - 1_116.325e6 - FEE);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }

    function test_RevertWhen_TheCompanyIsDissolved() public {
        uint256 id = createOrder(dissolved.requestHash);
        vm.expectRevert(abi.encodeWithSelector(CompliantInvoiceEscrow.CompanyNotActive.selector, dissolved.data));
        vm.prank(keeper);
        submit(id, fx, dissolved);
    }

    // Tamper tests on the company response

    function test_RevertWhen_DissolvedIsEditedToActive() public {
        uint256 id = createOrder(dissolved.requestHash);
        Response memory edited = dissolved;
        edited.data = '{"status":"active"}';
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        vm.prank(keeper);
        submit(id, fx, edited);
    }

    function test_RevertWhen_TheCompanyResponseIsTooOld() public {
        uint256 id = createOrder(active.requestHash);
        vm.warp(active.timestamp + 2 minutes + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                CompliantInvoiceEscrow.ResponseTooOld.selector, escrow.COMPANIES_HOUSE(), active.timestamp
            )
        );
        vm.prank(keeper);
        submit(id, fx, active);
    }

    function test_RevertWhen_TheResponseIsForAnotherActiveCompany() public {
        // The order is for the dissolved company; a real, fresh "active" response for another company does not pass.
        uint256 id = createOrder(dissolved.requestHash);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        vm.prank(keeper);
        submit(id, fx, otherActive);
    }

    function test_RevertWhen_AnotherKeySignedActive() public {
        uint256 id = createOrder(dissolved.requestHash);
        (address impostor, uint256 impostorKey) = makeAddrAndKey("impostor");
        Response memory forged = dissolved;
        forged.data = '{"status":"active"}';
        forged.signature = signResponse(impostorKey, dissolved.requestHash, dissolved.timestamp, forged.data);
        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, impostor));
        vm.prank(keeper);
        submit(id, fx, forged);
    }

    // The rate checks still hold

    function test_RevertWhen_TheRateIsNotBelowTheLimit() public {
        vm.prank(lena);
        uint256 id = escrow.createOrder(
            "INV-1",
            supplier,
            IERC20(address(usd)),
            CENTS,
            1.11e18,
            uint64(block.timestamp + 1 days),
            keeper,
            FEE,
            active.requestHash
        );
        vm.expectRevert(abi.encodeWithSelector(CompliantInvoiceEscrow.ConditionNotMet.selector, 1.116325e18, 1.11e18));
        vm.prank(keeper);
        submit(id, fx, active);
    }

    function test_RevertWhen_TheRateResponseIsForged() public {
        uint256 id = createOrder(active.requestHash);
        Response memory edited = fx;
        edited.data = '{"price":1.016325,"updatedAt":1793394164506}';
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        vm.prank(keeper);
        submit(id, edited, active);
    }

    function test_KeeperOnlyDuringTheExclusivePeriod_ThenAnyone() public {
        uint256 id = createOrder(active.requestHash);
        uint64 until = escrow.getOrder(id).exclusiveUntil;
        vm.expectRevert(abi.encodeWithSelector(CompliantInvoiceEscrow.KeeperOnly.selector, keeper, until));
        vm.prank(stranger);
        submit(id, fx, active);

        // An order opened 10 minutes before the responses were signed is open to anyone when they are fresh.
        vm.warp(fx.timestamp - 10 minutes);
        uint256 early = createOrder(active.requestHash);
        vm.warp(active.timestamp + 10);
        vm.prank(stranger);
        submit(early, fx, active);
        assertEq(usd.balanceOf(stranger), FEE);
    }

    function test_PayerCancelsAndGetsDepositAndFeeBack() public {
        uint256 id = createOrder(dissolved.requestHash);
        vm.prank(lena);
        escrow.cancel(id);
        assertEq(usd.balanceOf(lena), 10_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                CompliantInvoiceEscrow.OrderNotOpen.selector, id, CompliantInvoiceEscrow.Status.Cancelled
            )
        );
        vm.prank(keeper);
        submit(id, fx, active);
    }

    function test_RevertWhen_PaidTwice() public {
        uint256 id = createOrder(active.requestHash);
        vm.startPrank(keeper);
        submit(id, fx, active);
        vm.expectRevert(
            abi.encodeWithSelector(CompliantInvoiceEscrow.OrderNotOpen.selector, id, CompliantInvoiceEscrow.Status.Paid)
        );
        submit(id, fx, active);
        vm.stopPrank();
    }

    function createOrder(bytes32 companyRequestHash) private returns (uint256) {
        vm.prank(lena);
        return escrow.createOrder(
            "INV-7",
            supplier,
            IERC20(address(usd)),
            CENTS,
            1.13e18,
            uint64(block.timestamp + 1 days),
            keeper,
            FEE,
            companyRequestHash
        );
    }

    function submit(uint256 id, Response memory rate, Response memory company) private {
        escrow.execute(
            id,
            CompliantInvoiceEscrow.Signed(rate.timestamp, rate.data, rate.signature),
            CompliantInvoiceEscrow.Signed(company.timestamp, company.data, company.signature)
        );
    }

    function readFixture(string memory name) private view returns (Response memory) {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(string.concat("test/fixtures/", name));
        return Response({
            requestHash: vm.parseJsonBytes32(json, ".requestHash"),
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });
    }
}
