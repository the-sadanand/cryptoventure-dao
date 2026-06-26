// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title DAOAccessControl
 * @notice Central role registry for the CryptoVentures DAO.
 *
 * Role Hierarchy
 * ──────────────
 *  DEFAULT_ADMIN_ROLE  (multisig / deployer)
 *    └─ GUARDIAN_ROLE         – emergency pause / cancel proposals
 *    └─ EXECUTOR_ROLE         – execute queued proposals (granted to DAOGovernance)
 *    └─ TREASURER_ROLE        – trigger treasury transfers (granted to DAOGovernance)
 *    └─ PROPOSER_ROLE         – allowed to create proposals (any staker in practice;
 *                               the governance contract checks minimum stake separately)
 *
 * The deployer renounces DEFAULT_ADMIN_ROLE after initial setup and transfers it to
 * a Gnosis Safe or similar multisig to prevent single-key admin capture.
 */
contract DAOAccessControl is AccessControl {
    // ─────────────────────────────────────────────────────────────────────
    //  Role Constants
    // ─────────────────────────────────────────────────────────────────────

    bytes32 public constant GUARDIAN_ROLE  = keccak256("GUARDIAN_ROLE");
    bytes32 public constant EXECUTOR_ROLE  = keccak256("EXECUTOR_ROLE");
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");
    bytes32 public constant PROPOSER_ROLE  = keccak256("PROPOSER_ROLE");

    // ─────────────────────────────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @param admin Initial admin (typically a multisig)
     * @param guardian Emergency guardian address
     */
    constructor(address admin, address guardian) {
        require(admin    != address(0), "DAOAccessControl: zero admin");
        require(guardian != address(0), "DAOAccessControl: zero guardian");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE,      guardian);

        // Role admins — DEFAULT_ADMIN manages everything by default (OZ behaviour)
    }

    // ─────────────────────────────────────────────────────────────────────
    //  View Helpers
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Check whether an address is a guardian
     * @param account Address to check
     * @return bool
     */
    function isGuardian(address account) external view returns (bool) {
        return hasRole(GUARDIAN_ROLE, account);
    }

    /**
     * @notice Check whether an address has executor rights
     * @param account Address to check
     * @return bool
     */
    function isExecutor(address account) external view returns (bool) {
        return hasRole(EXECUTOR_ROLE, account);
    }

    /**
     * @notice Check whether an address has treasurer rights
     * @param account Address to check
     * @return bool
     */
    function isTreasurer(address account) external view returns (bool) {
        return hasRole(TREASURER_ROLE, account);
    }
}
