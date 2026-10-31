// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";
import {AirnodeV2Attestation} from "../contracts/AirnodeV2Attestation.sol";
import {CreatorDealEscrow} from "../contracts/creator/CreatorDealEscrow.sol";
import {DemoUSD} from "../contracts/payonproof/DemoUSD.sol";
import {AirnodeV2Test} from "./utils/AirnodeV2Test.sol";

contract CreatorDealEscrowTest is AirnodeV2Test {
    address constant TWITTERAPI = 0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB;
    // Real tweet by @Api3DAO, posted 2026-10-26T13:59:02Z, with "@tbc_munich" in its text and 2567 views when signed.
    uint256 constant API3_TWEET = 2114718447817064611;
    uint256 constant VIRAL_TWEET = 2088256120674570369;

    struct Signed {
        bytes32 requestHash;
        uint256 timestamp;
        bytes data;
        bytes signature;
    }

    DemoUSD token;
    CreatorDealEscrow realEscrow; // trusts the real TwitterAPI.io Airnode, for the recorded responses
    CreatorDealEscrow escrow; // trusts a test key, for made-up responses
    uint256 airnodeKey = 0xA11CE;
    address brand = makeAddr("brand");
    address creator = makeAddr("creator");
    address settler = makeAddr("settler");
    Signed real;
    Signed viral;

    function setUp() public {
        token = new DemoUSD();
        realEscrow = new CreatorDealEscrow(TWITTERAPI);
        escrow = new CreatorDealEscrow(vm.addr(airnodeKey));
        real = load("twitterapi-api3dao-tbc-munich.json");
        viral = load("twitterapi-api3dao-viral.json");
        token.mint(brand, 100_000e6);
        vm.startPrank(brand);
        token.approve(address(realEscrow), type(uint256).max);
        token.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
        vm.warp(real.timestamp + 30);
    }

    // ---- helpers ----

    function load(string memory name) internal view returns (Signed memory s) {
        string memory json = vm.readFile(string.concat("test/fixtures/", name));
        s = Signed({
            requestHash: vm.parseJsonBytes32(json, ".requestHash"),
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });
    }

    function terms(string memory handle, string memory code) internal view returns (CreatorDealEscrow.Terms memory) {
        return CreatorDealEscrow.Terms({
            token: token,
            creatorPayee: creator,
            creatorHandle: handle,
            code: code,
            notBefore: uint64(block.timestamp - 7 days),
            holdSeconds: 1 hours,
            deadline: uint64(block.timestamp + 1 days),
            minViews: 1000,
            payPerKViews: 1e6, // 1 dUSD per 1000 views
            maxPayout: 5e6,
            settlerFee: 0.1e6
        });
    }

    function openReal() internal returns (uint256) {
        vm.prank(brand);
        return realEscrow.createDeal(terms("Api3DAO", "@tbc_munich"));
    }

    function open(CreatorDealEscrow.Terms memory t) internal returns (uint256) {
        vm.prank(brand);
        return escrow.createDeal(t);
    }

    function tweetIdAt(uint256 unixSeconds) internal pure returns (uint256) {
        return (unixSeconds * 1000 - 1288834974657) << 22;
    }

    function tweetData(uint256 tweetId, string memory author, string memory text, uint256 views)
        internal
        pure
        returns (bytes memory)
    {
        return bytes(
            string.concat(
                '{"author":"',
                author,
                '","id":"',
                LibString.toString(tweetId),
                '","text":"',
                text,
                '","views":',
                LibString.toString(views),
                "}"
            )
        );
    }

    function settleMadeUp(uint256 dealId, uint256 tweetId, bytes memory data) internal returns (uint256) {
        bytes memory signature = signResponse(airnodeKey, escrow.tweetRequestHash(tweetId), block.timestamp, data);
        vm.prank(settler);
        return escrow.settle(dealId, tweetId, block.timestamp, data, signature);
    }

    function settleReverts(uint256 dealId, uint256 tweetId, bytes memory data, bytes memory err) internal {
        bytes memory signature = signResponse(airnodeKey, escrow.tweetRequestHash(tweetId), block.timestamp, data);
        vm.prank(settler);
        vm.expectRevert(err);
        escrow.settle(dealId, tweetId, block.timestamp, data, signature);
    }

    // ---- the request hash ----

    function test_requestHashMatchesTheAirnodes() public view {
        assertEq(realEscrow.tweetRequestHash(API3_TWEET), real.requestHash);
        assertEq(realEscrow.tweetRequestHash(VIRAL_TWEET), viral.requestHash);
    }

    function test_postedAtReadsTheSnowflakeId() public view {
        assertEq(realEscrow.postedAt(API3_TWEET), 1793023142); // 2026-10-26T13:59:02.185Z
        assertEq(realEscrow.postedAt(tweetIdAt(1_800_000_000)), 1_800_000_000);
    }

    // ---- a real signed response ----

    function test_settlesOnTheRealSignedTweet() public {
        uint256 dealId = openReal();
        vm.prank(settler);
        uint256 payout = realEscrow.settle(dealId, API3_TWEET, real.timestamp, real.data, real.signature);
        // 2567 views at 1 dUSD per 1000 views
        assertEq(payout, 2.567e6);
        assertEq(token.balanceOf(creator), 2.567e6);
        assertEq(token.balanceOf(settler), 0.1e6);
        assertEq(token.balanceOf(brand), 100_000e6 - 2.567e6 - 0.1e6);
        assertEq(token.balanceOf(address(realEscrow)), 0);
        assertEq(uint8(realEscrow.getDeal(dealId).status), uint8(CreatorDealEscrow.Status.Settled));
    }

    // ---- the four tampering cases ----

    function test_rejectsInflatedViews() public {
        uint256 dealId = openReal();
        bytes memory inflated = bytes(LibString.replace(string(real.data), '"views":2567', '"views":2567000'));
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        realEscrow.settle(dealId, API3_TWEET, real.timestamp, inflated, real.signature);
    }

    function test_rejectsAStaleResponse() public {
        uint256 dealId = openReal();
        vm.warp(real.timestamp + 2 minutes + 1);
        vm.expectRevert(abi.encodeWithSelector(CreatorDealEscrow.ResponseTooOld.selector, real.timestamp));
        realEscrow.settle(dealId, API3_TWEET, real.timestamp, real.data, real.signature);
    }

    function test_rejectsAnotherTweetsResponse() public {
        uint256 dealId = openReal();
        // A genuine signature, but over the request for someone's viral tweet, not this one.
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        realEscrow.settle(dealId, API3_TWEET, viral.timestamp, viral.data, viral.signature);
    }

    function test_rejectsAnotherSigner() public {
        uint256 dealId = openReal();
        bytes memory forged = signResponse(airnodeKey, real.requestHash, real.timestamp, real.data);
        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, vm.addr(airnodeKey)));
        realEscrow.settle(dealId, API3_TWEET, real.timestamp, real.data, forged);
    }

    // ---- business rules ----

    function test_paysByViewsCapsAndRefunds() public {
        uint256 dealId = open(terms("creator_x", "PAYONPOST-1"));
        uint256 tweetId = tweetIdAt(block.timestamp - 2 hours);
        assertEq(settleMadeUp(dealId, tweetId, tweetData(tweetId, "Creator_X", "#ad PAYONPOST-1 is live", 9000)), 5e6);
        assertEq(token.balanceOf(creator), 5e6); // 9 dUSD by views, capped at 5
        assertEq(token.balanceOf(settler), 0.1e6);
        assertEq(token.balanceOf(brand), 100_000e6 - 5e6 - 0.1e6);
    }

    function test_rejectsWrongAuthor() public {
        uint256 dealId = open(terms("creator_x", "PAYONPOST-1"));
        uint256 tweetId = tweetIdAt(block.timestamp - 2 hours);
        bytes memory data = tweetData(tweetId, "impostor", "#ad PAYONPOST-1", 9000);
        settleReverts(dealId, tweetId, data, abi.encodeWithSelector(CreatorDealEscrow.WrongAuthor.selector, "impostor"));
    }

    function test_rejectsMissingCode() public {
        uint256 dealId = open(terms("creator_x", "PAYONPOST-1"));
        uint256 tweetId = tweetIdAt(block.timestamp - 2 hours);
        bytes memory data = tweetData(tweetId, "creator_x", "#ad PAYONPOST-2", 9000);
        settleReverts(
            dealId, tweetId, data, abi.encodeWithSelector(CreatorDealEscrow.CodeMissing.selector, "PAYONPOST-1")
        );
    }

    function test_rejectsPostBeforeTheDeal() public {
        CreatorDealEscrow.Terms memory t = terms("creator_x", "PAYONPOST-1");
        t.notBefore = uint64(block.timestamp - 1 hours);
        uint256 dealId = open(t);
        uint256 tweetId = tweetIdAt(block.timestamp - 2 hours);
        bytes memory data = tweetData(tweetId, "creator_x", "#ad PAYONPOST-1", 9000);
        settleReverts(
            dealId,
            tweetId,
            data,
            abi.encodeWithSelector(CreatorDealEscrow.PostedTooEarly.selector, block.timestamp - 2 hours, t.notBefore)
        );
    }

    function test_rejectsPostNotHeldLongEnough() public {
        uint256 dealId = open(terms("creator_x", "PAYONPOST-1"));
        uint256 tweetId = tweetIdAt(block.timestamp - 30 minutes);
        bytes memory data = tweetData(tweetId, "creator_x", "#ad PAYONPOST-1", 9000);
        settleReverts(
            dealId,
            tweetId,
            data,
            abi.encodeWithSelector(
                CreatorDealEscrow.HoldNotOver.selector, block.timestamp - 30 minutes, 1 hours, block.timestamp
            )
        );
    }

    function test_rejectsTooFewViews() public {
        uint256 dealId = open(terms("creator_x", "PAYONPOST-1"));
        uint256 tweetId = tweetIdAt(block.timestamp - 2 hours);
        bytes memory data = tweetData(tweetId, "creator_x", "#ad PAYONPOST-1", 999);
        settleReverts(
            dealId, tweetId, data, abi.encodeWithSelector(CreatorDealEscrow.NotEnoughViews.selector, 999, 1000)
        );
    }

    function test_settlesOnlyOnce() public {
        uint256 dealId = open(terms("creator_x", "PAYONPOST-1"));
        uint256 tweetId = tweetIdAt(block.timestamp - 2 hours);
        bytes memory data = tweetData(tweetId, "creator_x", "#ad PAYONPOST-1", 2000);
        settleMadeUp(dealId, tweetId, data);
        settleReverts(
            dealId,
            tweetId,
            data,
            abi.encodeWithSelector(CreatorDealEscrow.DealNotOpen.selector, dealId, CreatorDealEscrow.Status.Settled)
        );
    }

    function test_onePostPaysOneDeal() public {
        uint256 first = open(terms("creator_x", "PAYONPOST-1"));
        uint256 second = open(terms("creator_x", "PAYONPOST-1"));
        uint256 tweetId = tweetIdAt(block.timestamp - 2 hours);
        bytes memory data = tweetData(tweetId, "creator_x", "#ad PAYONPOST-1", 2000);
        settleMadeUp(first, tweetId, data);
        settleReverts(
            second, tweetId, data, abi.encodeWithSelector(CreatorDealEscrow.TweetAlreadyUsed.selector, tweetId, first)
        );
    }

    function test_refundsAfterTheDeadline() public {
        CreatorDealEscrow.Terms memory t = terms("creator_x", "PAYONPOST-1");
        uint256 dealId = open(t);
        vm.expectRevert(abi.encodeWithSelector(CreatorDealEscrow.DealNotExpired.selector, dealId, t.deadline));
        escrow.refund(dealId);

        vm.warp(t.deadline + 1);
        uint256 tweetId = tweetIdAt(block.timestamp - 2 hours);
        bytes memory data = tweetData(tweetId, "creator_x", "#ad PAYONPOST-1", 2000);
        settleReverts(
            dealId, tweetId, data, abi.encodeWithSelector(CreatorDealEscrow.DealExpired.selector, dealId, t.deadline)
        );

        escrow.refund(dealId);
        assertEq(token.balanceOf(brand), 100_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(CreatorDealEscrow.DealNotOpen.selector, dealId, CreatorDealEscrow.Status.Refunded)
        );
        escrow.refund(dealId);
    }

    function test_rejectsBadTerms() public {
        CreatorDealEscrow.Terms memory t = terms("creator_x", "");
        vm.prank(brand);
        vm.expectRevert(CreatorDealEscrow.InvalidTerms.selector);
        escrow.createDeal(t);
    }
}
