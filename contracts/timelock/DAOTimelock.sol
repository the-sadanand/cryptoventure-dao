// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../access/DAOAccessControl.sol";

/**
 * @title DAOTimelock
 * @notice Lightweight timelock queue for governance proposal execution.
 *
 * Design
 * ──────
 * The timelock holds a mapping of operation hashes → earliest execution timestamp.
 * Proposals are queued with a delay determined by their type; they can only be
 * executed after that delay and before an expiry window (grace period).
 *
 * This contract does NOT execute arbitrary calls; that responsibility belongs to
 * DAOGovernance which calls Treasury.transfer() directly. The timelock is purely
 * a scheduling / safety mechanism.
 *
 * Security Properties
 * ───────────────────
 * • Only EXECUTOR_ROLE (DAOGovernance) may schedule and cancel operations.
 * • A queued operation's ETA is immutable once set (no re-queuing attacks).
 * • Operations expire after GRACE_PERIOD — preventing indefinite pending calls.
 */
contract DAOTimelock is ReentrancyGuard {

    // ─────────────────────────────────────────────────────────────────────
    //  Constants
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Operations expire 14 days after their ETA
    uint256 public constant GRACE_PERIOD = 14 days;

    // ─────────────────────────────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────────────────────────────

    DAOAccessControl public immutable accessControl;

    /// @dev operationId → earliest execution timestamp (0 = not queued)
    mapping(bytes32 => uint256) public queuedOperations;

    // ─────────────────────────────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────────────────────────────

    event OperationQueued(bytes32 indexed operationId, uint256 executionETA);
    event OperationExecuted(bytes32 indexed operationId);
    event OperationCancelled(bytes32 indexed operationId);

    // ─────────────────────────────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @param _accessControl DAOAccessControl address
     */
    constructor(address _accessControl) {
        require(_accessControl != address(0), "DAOTimelock: zero access control");
        accessControl = DAOAccessControl(_accessControl);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────────────────────────────

    modifier onlyExecutor() {
        require(
            accessControl.hasRole(accessControl.EXECUTOR_ROLE(), msg.sender),
            "DAOTimelock: not executor"
        );
        _;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Queue / Cancel / Execute
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Queue an operation with a delay
     * @dev Reverts if the operation is already queued.
     * @param operationId Unique identifier for this operation (keccak256 of proposal data)
     * @param delay Seconds before the operation may be executed
     * @return executionETA Timestamp after which execution is permitted
     */
    function queue(bytes32 operationId, uint256 delay) external onlyExecutor returns (uint256 executionETA) {
        require(queuedOperations[operationId] == 0, "DAOTimelock: already queued");
        require(delay > 0, "DAOTimelock: zero delay");

        executionETA = block.timestamp + delay;
        queuedOperations[operationId] = executionETA;

        emit OperationQueued(operationId, executionETA);
    }

    /**
     * @notice Mark an operation as executed (called by governance after successful execution)
     * @dev The caller (governance) is responsible for ensuring all execution logic ran first.
     * @param operationId Operation to mark
     */
    function markExecuted(bytes32 operationId) external onlyExecutor {
        uint256 eta = queuedOperations[operationId];
        require(eta != 0, "DAOTimelock: not queued");
        require(block.timestamp >= eta, "DAOTimelock: timelock not elapsed");
        require(block.timestamp <= eta + GRACE_PERIOD, "DAOTimelock: operation expired");

        queuedOperations[operationId] = 0;

        emit OperationExecuted(operationId);
    }

    /**
     * @notice Cancel a queued operation
     * @param operationId Operation to cancel
     */
    function cancel(bytes32 operationId) external onlyExecutor {
        require(queuedOperations[operationId] != 0, "DAOTimelock: not queued");
        queuedOperations[operationId] = 0;
        emit OperationCancelled(operationId);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Return whether an operation is currently queued
     * @param operationId Operation identifier
     * @return bool
     */
    function isQueued(bytes32 operationId) external view returns (bool) {
        return queuedOperations[operationId] != 0;
    }

    /**
     * @notice Return whether an operation is ready for execution
     * @param operationId Operation identifier
     * @return bool
     */
    function isReady(bytes32 operationId) external view returns (bool) {
        uint256 eta = queuedOperations[operationId];
        return eta != 0 && block.timestamp >= eta && block.timestamp <= eta + GRACE_PERIOD;
    }

    /**
     * @notice Return whether an operation has expired (queued but past grace period)
     * @param operationId Operation identifier
     * @return bool
     */
    function isExpired(bytes32 operationId) external view returns (bool) {
        uint256 eta = queuedOperations[operationId];
        return eta != 0 && block.timestamp > eta + GRACE_PERIOD;
    }

    /**
     * @notice Return the ETA for a queued operation (0 if not queued)
     * @param operationId Operation identifier
     * @return uint256 ETA timestamp
     */
    function getETA(bytes32 operationId) external view returns (uint256) {
        return queuedOperations[operationId];
    }
}
