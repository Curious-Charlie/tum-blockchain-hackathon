// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AirnodeV2Attestation} from "../AirnodeV2Attestation.sol";
import {ProjectedJson} from "../ProjectedJson.sol";

/// @title PayOnProof, compliant: an agent pays verified suppliers only
/// @notice InvoiceEscrowV2 plus a company check. The payer's agent fixes, when it opens the order, the hash of the
/// Companies House request for the supplier's company number. The order pays only with two fresh signed responses:
/// Nodary's EUR/USD below the limit, and Companies House saying that this company is active. The supplier, the Keeper's
/// fee and the payer's refund settle in one transaction, and the contract records which signed data it relied on.
contract CompliantInvoiceEscrow {
    using SafeERC20 for IERC20;

    /// @notice Nodary Airnode v2 (EUR/USD)
    address public constant NODARY = 0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0;
    /// @notice Companies House Airnode v2 (UK company register), from https://airnode-companies-house.fly.dev/
    address public constant COMPANIES_HOUSE = 0x392228E5CCA260313e5ed337Ed3561B59A1e4bFF;

    /// @notice Longest time from an Airnode signing a response to the contract accepting it, for every response
    uint256 public constant MAX_RESPONSE_AGE = 2 minutes;
    /// @notice How long after creation only the order's Keeper may execute it
    uint256 public constant EXCLUSIVE_PERIOD = 10 minutes;
    /// @notice The only company data that pays: `getCompanyProfile` projected to {"status":"/company_status"}
    bytes32 public constant ACTIVE = keccak256('{"status":"active"}');

    /// @notice Nodary `latestFeeds` EUR/USD projected to {"price","updatedAt"}
    bytes32 public immutable fxRequestHash;
    /// @notice Longest time from Nodary taking the rate to the contract accepting it (FX closes on weekends)
    uint256 public immutable maxRateAge;

    enum Status {
        None,
        Open,
        Paid,
        Cancelled
    }

    struct Order {
        address payer;
        address payee;
        IERC20 token;
        Status status;
        uint64 deadline;
        uint64 exclusiveUntil;
        address keeper;
        uint256 amountEurCents;
        uint256 maxRate;
        uint256 deposit;
        uint256 keeperFee;
        bytes32 invoiceRef;
        /// Companies House request for the payee's company number, fixed by the payer
        bytes32 companyRequestHash;
    }

    /// @notice A signed Airnode v2 response
    struct Signed {
        uint256 timestamp;
        bytes data;
        bytes signature;
    }

    uint256 public orderCount;
    mapping(uint256 => Order) private orders;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed payer,
        address indexed payee,
        bytes32 invoiceRef,
        bytes32 companyRequestHash,
        uint256 amountEurCents,
        uint256 maxRate,
        uint256 deposit,
        uint64 deadline,
        address keeper,
        uint256 keeperFee
    );
    event InvoicePaid(
        uint256 indexed orderId,
        address indexed executor,
        address indexed payee,
        uint256 rate,
        uint256 payout,
        uint256 keeperFee,
        uint256 refund
    );
    /// @notice Which signed data the payment relied on: signer, request and signing time of each response
    event ComplianceEvidence(
        uint256 indexed orderId,
        address fxSigner,
        bytes32 fxRequestHash,
        uint256 fxTimestamp,
        address companySigner,
        bytes32 companyRequestHash,
        uint256 companyTimestamp
    );
    event OrderCancelled(uint256 indexed orderId, uint256 refund);

    error InvalidOrder();
    error OrderNotOpen(uint256 orderId, Status status);
    error OrderExpired(uint256 orderId, uint64 deadline);
    error NotPayer(address caller);
    error KeeperOnly(address keeper, uint64 exclusiveUntil);
    error ResponseTooOld(address airnode, uint256 responseTimestamp);
    error RateTooOld(uint256 rateTimestamp);
    error ConditionNotMet(uint256 rate, uint256 maxRate);
    error CompanyNotActive(bytes data);

    constructor(bytes32 fxRequestHash_, uint256 maxRateAge_) {
        fxRequestHash = fxRequestHash_;
        maxRateAge = maxRateAge_;
    }

    /// @notice Locks the invoice at `maxRate` plus `keeperFee`. `companyRequestHash` binds the company check to the
    /// payee's company number: `companyRequestHash(number)` in src/payonproof/companies-house.ts.
    function createOrder(
        bytes32 invoiceRef,
        address payee,
        IERC20 token,
        uint256 amountEurCents,
        uint256 maxRate,
        uint64 deadline,
        address keeper,
        uint256 keeperFee,
        bytes32 companyRequestHash
    ) external returns (uint256 orderId) {
        if (
            payee == address(0) || keeper == address(0) || amountEurCents == 0 || maxRate == 0
                || deadline <= block.timestamp || companyRequestHash == bytes32(0)
        ) {
            revert InvalidOrder();
        }
        uint256 deposit = quote(token, amountEurCents, maxRate);
        orderId = ++orderCount;
        Order storage order = orders[orderId];
        order.payer = msg.sender;
        order.payee = payee;
        order.token = token;
        order.status = Status.Open;
        order.deadline = deadline;
        order.exclusiveUntil = uint64(block.timestamp + EXCLUSIVE_PERIOD);
        order.keeper = keeper;
        order.amountEurCents = amountEurCents;
        order.maxRate = maxRate;
        order.deposit = deposit;
        order.keeperFee = keeperFee;
        order.invoiceRef = invoiceRef;
        order.companyRequestHash = companyRequestHash;
        emit OrderCreated(
            orderId,
            msg.sender,
            payee,
            invoiceRef,
            companyRequestHash,
            amountEurCents,
            maxRate,
            deposit,
            deadline,
            keeper,
            keeperFee
        );
        token.safeTransferFrom(msg.sender, address(this), deposit + keeperFee);
    }

    /// @notice Pays the invoice and the executor's fee if the supplier's company is active and EUR/USD is below the
    /// limit, both from fresh signed responses
    function execute(uint256 orderId, Signed calldata fx, Signed calldata company) external returns (uint256 payout) {
        Order storage order = orders[orderId];
        if (order.status != Status.Open) revert OrderNotOpen(orderId, order.status);
        if (block.timestamp > order.deadline) revert OrderExpired(orderId, order.deadline);
        if (block.timestamp < order.exclusiveUntil && msg.sender != order.keeper) {
            revert KeeperOnly(order.keeper, order.exclusiveUntil);
        }

        // The company: Companies House signed this request (this company number), recently, and it says "active".
        _verifyFresh(COMPANIES_HOUSE, order.companyRequestHash, company);
        if (keccak256(company.data) != ACTIVE) revert CompanyNotActive(company.data);

        // The rate: v1's checks.
        _verifyFresh(NODARY, fxRequestHash, fx);
        uint256 rate = ProjectedJson.readUint(fx.data, "price", 18);
        uint256 rateTimestamp = ProjectedJson.readUint(fx.data, "updatedAt", 0) / 1000;
        if (rateTimestamp + maxRateAge < block.timestamp) revert RateTooOld(rateTimestamp);
        if (rate >= order.maxRate) revert ConditionNotMet(rate, order.maxRate);

        payout = quote(order.token, order.amountEurCents, rate);
        uint256 refund = order.deposit - payout;
        uint256 fee = order.keeperFee;
        order.status = Status.Paid;
        emit InvoicePaid(orderId, msg.sender, order.payee, rate, payout, fee, refund);
        emit ComplianceEvidence(
            orderId, NODARY, fxRequestHash, fx.timestamp, COMPANIES_HOUSE, order.companyRequestHash, company.timestamp
        );

        order.token.safeTransfer(order.payee, payout);
        if (fee > 0) order.token.safeTransfer(msg.sender, fee);
        if (refund > 0) order.token.safeTransfer(order.payer, refund);
    }

    /// @notice The payer takes back the deposit and the fee of an order that has not been paid
    function cancel(uint256 orderId) external {
        Order storage order = orders[orderId];
        if (order.status != Status.Open) revert OrderNotOpen(orderId, order.status);
        if (msg.sender != order.payer) revert NotPayer(msg.sender);
        order.status = Status.Cancelled;
        uint256 refund = order.deposit + order.keeperFee;
        emit OrderCancelled(orderId, refund);
        order.token.safeTransfer(order.payer, refund);
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    /// @notice Token units for `amountEurCents` at `rate` (EUR/USD, 18 decimals), rounded up
    function quote(IERC20 token, uint256 amountEurCents, uint256 rate) public view returns (uint256) {
        uint256 unit = 10 ** IERC20Metadata(address(token)).decimals();
        return Math.mulDiv(amountEurCents * unit, rate, 100 * 1e18, Math.Rounding.Ceil);
    }

    /// @dev Signer and request (the request hash goes into the digest), then freshness: the signature covers the time.
    function _verifyFresh(address airnode, bytes32 requestHash, Signed calldata response) private view {
        AirnodeV2Attestation.verify(airnode, requestHash, response.timestamp, response.data, response.signature);
        if (response.timestamp + MAX_RESPONSE_AGE < block.timestamp) {
            revert ResponseTooOld(airnode, response.timestamp);
        }
    }
}
