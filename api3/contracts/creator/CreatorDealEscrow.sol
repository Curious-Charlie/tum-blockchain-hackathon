// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibString} from "solady/utils/LibString.sol";
import {AirnodeV2Attestation} from "../AirnodeV2Attestation.sol";
import {ProjectedJson} from "../ProjectedJson.sol";

/// @title Pay-per-post escrow for creator deals, settled on a tweet that TwitterAPI.io signed through AirnodeHub
/// @notice A brand locks a budget for a sponsored post on X. The money moves only when a signed tweetsByIds response
/// shows that the post exists, was written by the agreed creator, contains the deal code, was posted after the deal
/// opened, has stayed up for the hold period, and has enough views. The creator gets views x price per 1000 views, up
/// to a cap; whoever submits the proof gets a fixed settler fee in the same transaction; the rest goes back to the
/// brand. No LLM and no off-chain party decides: the contract reads the signed bytes.
/// @dev The contract rebuilds the request hash from the tweet id, so a response to any other request (another tweet,
/// another projection, another operation) recovers a different signer and reverts.
contract CreatorDealEscrow {
    using SafeERC20 for IERC20;

    /// @notice Oldest signed response that settle accepts, so a post deleted since then cannot be paid on old proof
    uint256 public constant MAX_RESPONSE_AGE = 2 minutes;

    /// @notice X ids are Snowflake ids: their top bits count milliseconds since this Unix time in milliseconds
    uint256 public constant TWITTER_EPOCH_MS = 1288834974657;

    /// @notice The TwitterAPI.io Airnode v2 on AirnodeHub, 0x7B02Fd3324D2dC362f65a9c01e59EC5fDb4E1CCB
    address public immutable airnode;

    enum Status {
        None,
        Open,
        Settled,
        Refunded
    }

    /// @notice What the brand offers. All amounts are in `token` units.
    /// @param notBefore Earliest post time that the brand accepts (Unix seconds), so an older post cannot be reused
    /// @param holdSeconds How long the post must have been up when TwitterAPI.io signs it
    /// @param minViews Views that the post needs before anything is paid
    /// @param payPerKViews Price per 1000 views
    /// @param maxPayout Cap on the creator's payout, deposited in full
    /// @param settlerFee Paid to whoever submits the proof, deposited on top of maxPayout
    /// @param deadline After this the deal cannot settle and the brand can take the deposit back
    struct Terms {
        IERC20 token;
        address creatorPayee;
        string creatorHandle;
        string code;
        uint64 notBefore;
        uint64 holdSeconds;
        uint64 deadline;
        uint256 minViews;
        uint256 payPerKViews;
        uint256 maxPayout;
        uint256 settlerFee;
    }

    struct Deal {
        address brand;
        Status status;
        Terms terms;
    }

    uint256 public dealCount;
    mapping(uint256 => Deal) private deals;
    /// @notice A post pays out once, even if a brand opens several deals with the same creator and code
    mapping(uint256 => uint256) public dealOfTweet;

    event DealCreated(
        uint256 indexed dealId,
        address indexed brand,
        address indexed creatorPayee,
        string creatorHandle,
        string code,
        uint256 maxPayout,
        uint256 settlerFee,
        uint64 deadline
    );
    event DealSettled(
        uint256 indexed dealId,
        uint256 indexed tweetId,
        uint256 views,
        uint256 payout,
        address signer,
        bytes32 requestHash,
        uint256 timestamp
    );
    event SettlerPaid(uint256 indexed dealId, address indexed settler, uint256 fee, uint256 refund);
    event DealRefunded(uint256 indexed dealId, uint256 amount);

    error InvalidTerms();
    error DealNotOpen(uint256 dealId, Status status);
    error DealExpired(uint256 dealId, uint64 deadline);
    error DealNotExpired(uint256 dealId, uint64 deadline);
    error TweetAlreadyUsed(uint256 tweetId, uint256 dealId);
    error ResponseTooOld(uint256 responseTimestamp);
    error PostedTooEarly(uint256 postedAt, uint64 notBefore);
    error HoldNotOver(uint256 postedAt, uint64 holdSeconds, uint256 responseTimestamp);
    error WrongTweet(string id);
    error WrongAuthor(string author);
    error CodeMissing(string code);
    error NotEnoughViews(uint256 views, uint256 minViews);

    constructor(address airnode_) {
        airnode = airnode_;
    }

    /// @notice Opens a deal and takes maxPayout + settlerFee from the caller, who becomes the brand
    function createDeal(Terms calldata terms) external returns (uint256 dealId) {
        if (
            terms.creatorPayee == address(0) || bytes(terms.creatorHandle).length == 0 || bytes(terms.code).length == 0
                || terms.maxPayout == 0 || terms.payPerKViews == 0 || terms.deadline <= block.timestamp
        ) revert InvalidTerms();
        dealId = ++dealCount;
        deals[dealId] = Deal({brand: msg.sender, status: Status.Open, terms: terms});
        emit DealCreated(
            dealId,
            msg.sender,
            terms.creatorPayee,
            terms.creatorHandle,
            terms.code,
            terms.maxPayout,
            terms.settlerFee,
            terms.deadline
        );
        terms.token.safeTransferFrom(msg.sender, address(this), terms.maxPayout + terms.settlerFee);
    }

    /// @notice Pays the creator for the post `tweetId`, on TwitterAPI.io's signed answer to tweetsByIds for it.
    /// Anyone can call it; the caller gets the settler fee.
    /// @param timestamp, data, signature The signed response, with `data` as the exact bytes that the Airnode signed,
    /// such as {"author":"Api3DAO","id":"2114718447817064611","text":"…","views":2567}
    function settle(uint256 dealId, uint256 tweetId, uint256 timestamp, bytes calldata data, bytes calldata signature)
        external
        returns (uint256 payout)
    {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Open) revert DealNotOpen(dealId, deal.status);
        if (block.timestamp > deal.terms.deadline) revert DealExpired(dealId, deal.terms.deadline);
        if (dealOfTweet[tweetId] != 0) revert TweetAlreadyUsed(tweetId, dealOfTweet[tweetId]);

        // The signer and the request: the request hash is rebuilt from the tweet id, never taken from the caller.
        AirnodeV2Attestation.verify(airnode, tweetRequestHash(tweetId), timestamp, data, signature);
        // The signature covers the timestamp, so it can be trusted from here on.
        if (timestamp + MAX_RESPONSE_AGE < block.timestamp) revert ResponseTooOld(timestamp);

        uint256 views = checkPost(deal.terms, tweetId, timestamp, data);
        payout = pay(dealId, tweetId, views, timestamp);
    }

    /// @notice After the deadline, gives an unsettled deal's whole deposit back to the brand. Anyone can call it.
    function refund(uint256 dealId) external {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Open) revert DealNotOpen(dealId, deal.status);
        if (block.timestamp <= deal.terms.deadline) revert DealNotExpired(dealId, deal.terms.deadline);
        deal.status = Status.Refunded;
        uint256 amount = deal.terms.maxPayout + deal.terms.settlerFee;
        emit DealRefunded(dealId, amount);
        deal.terms.token.safeTransfer(deal.brand, amount);
    }

    /// @notice The request hash of tweetsByIds for one tweet, with the projection that settle reads, built as
    /// AirnodeHub does: keccak256 of JSON.stringify([operation, sorted parameter entries, sorted projection entries])
    function tweetRequestHash(uint256 tweetId) public pure returns (bytes32) {
        return keccak256(
            bytes(
                string.concat(
                    '["tweetsByIds",[["tweet_ids","',
                    LibString.toString(tweetId),
                    '"]],[["author","/tweets/0/author/userName"],["id","/tweets/0/id"],["text","/tweets/0/text"],',
                    '["views","/tweets/0/viewCount"]]]'
                )
            )
        );
    }

    /// @notice When a tweet was posted, in Unix seconds, read from its Snowflake id
    function postedAt(uint256 tweetId) public pure returns (uint256) {
        return ((tweetId >> 22) + TWITTER_EPOCH_MS) / 1000;
    }

    function getDeal(uint256 dealId) external view returns (Deal memory) {
        return deals[dealId];
    }

    /// @dev Creator first, then the settler fee, then the rest back to the brand, all in one transaction.
    function pay(uint256 dealId, uint256 tweetId, uint256 views, uint256 timestamp) private returns (uint256 payout) {
        Deal storage deal = deals[dealId];
        Terms storage terms = deal.terms;
        payout = views * terms.payPerKViews / 1000;
        if (payout > terms.maxPayout) payout = terms.maxPayout;
        uint256 refund_ = terms.maxPayout - payout;
        deal.status = Status.Settled;
        dealOfTweet[tweetId] = dealId;
        emit DealSettled(dealId, tweetId, views, payout, airnode, tweetRequestHash(tweetId), timestamp);
        emit SettlerPaid(dealId, msg.sender, terms.settlerFee, refund_);

        terms.token.safeTransfer(terms.creatorPayee, payout);
        if (terms.settlerFee > 0) terms.token.safeTransfer(msg.sender, terms.settlerFee);
        if (refund_ > 0) terms.token.safeTransfer(deal.brand, refund_);
    }

    /// @dev The business rules, on signed bytes only. Returns the signed view count.
    function checkPost(Terms storage terms, uint256 tweetId, uint256 timestamp, bytes calldata data)
        private
        view
        returns (uint256 views)
    {
        uint256 posted = postedAt(tweetId);
        if (posted < terms.notBefore) revert PostedTooEarly(posted, terms.notBefore);
        // The tweet resolved when the Airnode signed, so it had been up for at least this long.
        if (posted + terms.holdSeconds > timestamp) revert HoldNotOver(posted, terms.holdSeconds, timestamp);

        string memory id = ProjectedJson.readString(data, "id");
        if (!LibString.eq(id, LibString.toString(tweetId))) revert WrongTweet(id);
        // X handles ignore case.
        string memory author = ProjectedJson.readString(data, "author");
        if (!LibString.eq(LibString.lower(author), LibString.lower(terms.creatorHandle))) revert WrongAuthor(author);
        if (!LibString.contains(ProjectedJson.readString(data, "text"), terms.code)) revert CodeMissing(terms.code);

        views = ProjectedJson.readUint(data, "views", 0);
        if (views < terms.minViews) revert NotEnoughViews(views, terms.minViews);
    }
}
