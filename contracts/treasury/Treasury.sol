// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "../interfaces/ITreasury.sol";
import "../access/DAOAccessControl.sol";

/**
 * @title Treasury
 * @notice Multi-tier ETH treasury for CryptoVentures DAO.
 *
 * Security Model
 * ──────────────
 * • Only the TREASURER_ROLE (granted to DAOGovernance) may initiate transfers.
 * • Each proposal type has a maximum allocation cap (BPS of current balance).
 * • Reentrancy is blocked via ReentrancyGuard on all state-changing paths.
 * • The contract can be paused by a GUARDIAN_ROLE holder in emergencies.
 * • Allocation caps are validated before every transfer.
 *
 * Treasury Drain Protection
 * ─────────────────────────
 * Even if governance is compromised, the per-proposal-type cap limits how much
 * can leave in a single transaction. Multiple proposals are rate-limited by the
 * timelock delay between queue and execution.
 */
contract Treasury is ITreasury, ReentrancyGuard, Pausable {

    // ─────────────────────────────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────────────────────────────

    DAOAccessControl public immutable accessControl;

    /// @dev proposalType (uint8) → maximum allocation in basis points of current balance
    mapping(uint8 => uint16) private _allocationCapsBPS;

    // ─────────────────────────────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @param _accessControl Address of the DAOAccessControl contract
     */
    constructor(address _accessControl) {
        require(_accessControl != address(0), "Treasury: zero access control");
        accessControl = DAOAccessControl(_accessControl);

        // Default caps per GovernanceTypes.ProposalType enum values
        // 0 = HighConviction: 60%
        // 1 = Experimental:   30%
        // 2 = Operational:    10%
        _allocationCapsBPS[0] = 6000;
        _allocationCapsBPS[1] = 3000;
        _allocationCapsBPS[2] = 1000;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Receive ETH
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Accept ETH deposits into the treasury
     */
    receive() external payable override {
        emit TreasuryDeposit(msg.sender, msg.value);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Transfer (Governance-controlled)
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Transfer ETH to a recipient on behalf of an executed proposal
     * @dev Only callable by TREASURER_ROLE. Validates allocation cap before transfer.
     * @param recipient Address to receive ETH
     * @param amount Amount in wei
     * @param proposalId ID of the authorising proposal (for event logging)
     * @param proposalType Numeric value of GovernanceTypes.ProposalType
     */
    function transfer(
        address payable recipient,
        uint256 amount,
        uint256 proposalId,
        uint8 proposalType
    ) external override nonReentrant whenNotPaused {
        require(
            accessControl.hasRole(accessControl.TREASURER_ROLE(), msg.sender),
            "Treasury: caller is not treasurer"
        );
        require(recipient != address(0), "Treasury: zero recipient");
        require(amount > 0, "Treasury: zero amount");
        require(address(this).balance >= amount, "Treasury: insufficient balance");
        require(validateAllocation(proposalType, amount), "Treasury: exceeds allocation cap");

        // Effects before interaction (CEI pattern)
        uint256 remaining = address(this).balance - amount;

        // Interaction
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "Treasury: ETH transfer failed");

        emit TreasuryTransfer(recipient, amount, proposalId, remaining);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Validate that an amount is within the allocation cap for a proposal type
     * @param proposalType Numeric proposal type
     * @param amount Requested amount in wei
     * @return valid True if within cap
     */
    function validateAllocation(uint8 proposalType, uint256 amount) public view override returns (bool valid) {
        uint256 cap = maxAllocation(proposalType);
        return amount <= cap;
    }

    /**
     * @notice Return the current ETH balance held by the treasury
     * @return uint256 Balance in wei
     */
    function balance() external view override returns (uint256) {
        return address(this).balance;
    }

    /**
     * @notice Return the maximum ETH that can be disbursed in a single proposal of a given type
     * @param proposalType Numeric proposal type
     * @return uint256 Max allocation in wei
     */
    function maxAllocation(uint8 proposalType) public view override returns (uint256) {
        uint16 capBPS = _allocationCapsBPS[proposalType];
        if (capBPS == 0) return 0;
        return (address(this).balance * capBPS) / 10_000;
    }

    /**
     * @notice Return the allocation cap in basis points for a proposal type
     * @param proposalType Numeric proposal type
     * @return uint16 Cap in BPS
     */
    function allocationCapBPS(uint8 proposalType) external view returns (uint16) {
        return _allocationCapsBPS[proposalType];
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Update the allocation cap for a proposal type
     * @dev Only callable by DEFAULT_ADMIN_ROLE
     * @param proposalType Numeric proposal type
     * @param newCapBPS New cap in basis points (max 10000)
     */
    function setAllocationCap(uint8 proposalType, uint16 newCapBPS) external {
        require(
            accessControl.hasRole(accessControl.DEFAULT_ADMIN_ROLE(), msg.sender),
            "Treasury: not admin"
        );
        require(newCapBPS <= 10_000, "Treasury: cap exceeds 100%");
        _allocationCapsBPS[proposalType] = newCapBPS;
        emit AllocationCapUpdated(proposalType, newCapBPS);
    }

    /**
     * @notice Pause the treasury (guardian only)
     */
    function pause() external {
        require(accessControl.isGuardian(msg.sender), "Treasury: not guardian");
        _pause();
        emit EmergencyPause(msg.sender);
    }

    /**
     * @notice Unpause the treasury (guardian only)
     */
    function unpause() external {
        require(accessControl.isGuardian(msg.sender), "Treasury: not guardian");
        _unpause();
        emit EmergencyUnpause(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Events (treasury-local, for pause — Transfer event is in ITreasury)
    // ─────────────────────────────────────────────────────────────────────

    event EmergencyPause(address indexed by);
    event EmergencyUnpause(address indexed by);
}
