// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ITreasury
 * @notice Interface for the CryptoVentures DAO treasury contract
 */
interface ITreasury {
    // ─────────────────────────────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────────────────────────────

    event TreasuryDeposit(address indexed sender, uint256 amount);

    event TreasuryTransfer(
        address indexed recipient,
        uint256 amount,
        uint256 proposalId,
        uint256 remainingBalance
    );

    event AllocationCapUpdated(uint8 indexed proposalType, uint16 newCapBPS);

    // ─────────────────────────────────────────────────────────────────────
    //  Functions
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Accept ETH into the treasury
    receive() external payable;

    /// @notice Transfer ETH to a recipient — only callable by the governance executor
    function transfer(
        address payable recipient,
        uint256 amount,
        uint256 proposalId,
        uint8 proposalType
    ) external;

    /// @notice Validate that an amount is within the allowed allocation for a proposal type
    function validateAllocation(uint8 proposalType, uint256 amount) external view returns (bool);

    /// @notice Return the current ETH balance held by the treasury
    function balance() external view returns (uint256);

    /// @notice Return the maximum ETH that can be allocated for a given proposal type
    function maxAllocation(uint8 proposalType) external view returns (uint256);
}
