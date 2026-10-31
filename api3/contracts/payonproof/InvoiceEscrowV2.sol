// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AirnodeV2Attestation} from "../AirnodeV2Attestation.sol";
import {ProjectedJson} from "../ProjectedJson.sol";

/// @title PayOnProof v2, single chain: pays a EUR invoice and the Keeper's fee in one transaction
/// @notice The payer (Lena) locks the invoice amount at her limit rate plus the fee of the Keeper she chose. A Keeper
/// submits a response that the Nodary Airnode v2 signed for EUR/USD. The contract checks the signer, the request and
/// the time itself. If the signed rate is below the limit, the same transaction pays the payee at that rate, pays the
/// fee to whoever executed, and refunds the rest to the payer. For the first 10 minutes only the chosen Keeper may
/// execute; after that anyone may, so the order does not depend on one Keeper staying online. The fee is paid for the
/// execution itself, so there is no result to report and nothing to dispute afterwards.
contract InvoiceEscrowV2 {
    using SafeERC20 for IERC20;

    /// @notice Address that the Nodary Airnode v2 signs with
    address public constant AIRNODE_V2 = 0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0;

    /// @notice Longest time from the Airnode signing a response to the contract accepting it
    uint256 public constant MAX_RESPONSE_AGE = 2 minutes;

    /// @notice How long after creation only the order's Keeper may execute it
    uint256 public constant EXCLUSIVE_PERIOD = 10 minutes;

    /// @notice Hash of the only request whose responses the contract accepts: Nodary `latestFeeds` for EUR/USD,
    /// projected to {"price","updatedAt"}. `pnpm --silent request-hash EUR/USD` prints it.
    bytes32 public immutable requestHash;

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
        /// Until then only `keeper` may execute
        uint64 exclusiveUntil;
        address keeper;
        /// Invoice amount in euro cents
        uint256 amountEurCents;
        /// EUR/USD limit with 18 decimals: the order executes only when the signed rate is strictly below it
        uint256 maxRate;
        /// Token units locked for the invoice: the invoice converted at `maxRate`
        uint256 deposit;
        /// Token units locked for the executor, paid in the same transaction as the invoice
        uint256 keeperFee;
        /// Invoice reference such as "INV-17", as bytes32
        bytes32 invoiceRef;
    }

    uint256 public orderCount;
    mapping(uint256 => Order) private orders;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed payer,
        address indexed payee,
        bytes32 invoiceRef,
        address token,
        uint256 amountEurCents,
        uint256 maxRate,
        uint256 deposit,
        uint64 deadline,
        address keeper,
        uint256 keeperFee,
        uint64 exclusiveUntil
    );
    /// @notice `requestHash` and `responseTimestamp` name the signed response the payment relied on
    event InvoicePaid(
        uint256 indexed orderId,
        address indexed executor,
        address indexed payee,
        bytes32 requestHash,
        uint256 responseTimestamp,
        uint256 rate,
        uint256 rateTimestamp,
        uint256 payout,
        uint256 keeperFee,
        uint256 refund
    );
    event OrderCancelled(uint256 indexed orderId, uint256 refund);

    error InvalidOrder();
    error OrderNotOpen(uint256 orderId, Status status);
    error OrderExpired(uint256 orderId, uint64 deadline);
    error NotPayer(address caller);
    error KeeperOnly(address keeper, uint64 exclusiveUntil);
    error ResponseTooOld(uint256 responseTimestamp);
    error RateTooOld(uint256 rateTimestamp);
    error ConditionNotMet(uint256 rate, uint256 maxRate);

    constructor(bytes32 requestHash_, uint256 maxRateAge_) {
        requestHash = requestHash_;
        maxRateAge = maxRateAge_;
    }

    /// @notice Locks the invoice at `maxRate` plus `keeperFee`, and opens an order that pays `payee` once
    /// EUR/USD < `maxRate`
    /// @dev Approve the escrow for `quote(token, amountEurCents, maxRate) + keeperFee` first.
    function createOrder(
        bytes32 invoiceRef,
        address payee,
        IERC20 token,
        uint256 amountEurCents,
        uint256 maxRate,
        uint64 deadline,
        address keeper,
        uint256 keeperFee
    ) external returns (uint256 orderId) {
        if (
            payee == address(0) || keeper == address(0) || amountEurCents == 0 || maxRate == 0
                || deadline <= block.timestamp
        ) {
            revert InvalidOrder();
        }
        uint256 deposit = quote(token, amountEurCents, maxRate);
        uint64 exclusiveUntil = uint64(block.timestamp + EXCLUSIVE_PERIOD);
        orderId = ++orderCount;
        orders[orderId] = Order({
            payer: msg.sender,
            payee: payee,
            token: token,
            status: Status.Open,
            deadline: deadline,
            exclusiveUntil: exclusiveUntil,
            keeper: keeper,
            amountEurCents: amountEurCents,
            maxRate: maxRate,
            deposit: deposit,
            keeperFee: keeperFee,
            invoiceRef: invoiceRef
        });
        emit OrderCreated(
            orderId,
            msg.sender,
            payee,
            invoiceRef,
            address(token),
            amountEurCents,
            maxRate,
            deposit,
            deadline,
            keeper,
            keeperFee,
            exclusiveUntil
        );
        token.safeTransferFrom(msg.sender, address(this), deposit + keeperFee);
    }

    /// @notice Pays the invoice and the executor's fee if a fresh, Nodary-signed EUR/USD rate is below the limit
    /// @param timestamp `timestamp` of the signed response
    /// @param data `data` of the signed response, as the JSON string that the Airnode signed
    /// @param signature `signature` of the signed response
    /// @return payout Token units paid to the payee
    function execute(uint256 orderId, uint256 timestamp, bytes calldata data, bytes calldata signature)
        external
        returns (uint256 payout)
    {
        Order storage order = orders[orderId];
        if (order.status != Status.Open) revert OrderNotOpen(orderId, order.status);
        if (block.timestamp > order.deadline) revert OrderExpired(orderId, order.deadline);
        if (block.timestamp < order.exclusiveUntil && msg.sender != order.keeper) {
            revert KeeperOnly(order.keeper, order.exclusiveUntil);
        }

        // The signer and the request: the stored request hash goes into the digest.
        AirnodeV2Attestation.verify(AIRNODE_V2, requestHash, timestamp, data, signature);
        if (timestamp + MAX_RESPONSE_AGE < block.timestamp) revert ResponseTooOld(timestamp);

        uint256 rate = ProjectedJson.readUint(data, "price", 18);
        // Nodary gives its timestamps in milliseconds.
        uint256 rateTimestamp = ProjectedJson.readUint(data, "updatedAt", 0) / 1000;
        if (rateTimestamp + maxRateAge < block.timestamp) revert RateTooOld(rateTimestamp);

        if (rate >= order.maxRate) revert ConditionNotMet(rate, order.maxRate);

        // rate < maxRate, so payout <= deposit.
        payout = quote(order.token, order.amountEurCents, rate);
        uint256 refund = order.deposit - payout;
        uint256 fee = order.keeperFee;
        order.status = Status.Paid;
        emit InvoicePaid(
            orderId, msg.sender, order.payee, requestHash, timestamp, rate, rateTimestamp, payout, fee, refund
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

    /// @notice Token units for `amountEurCents` at `rate` (EUR/USD, 18 decimals), rounded up so the payee never gets less
    function quote(IERC20 token, uint256 amountEurCents, uint256 rate) public view returns (uint256) {
        uint256 unit = 10 ** IERC20Metadata(address(token)).decimals();
        return Math.mulDiv(amountEurCents * unit, rate, 100 * 1e18, Math.Rounding.Ceil);
    }
}
