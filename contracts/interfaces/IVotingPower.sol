// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IVotingPower
 * @notice Interface for the quadratic voting power calculator
 */
interface IVotingPower {
    /**
     * @notice Calculate quadratic voting power from a raw ETH stake
     * @param stake Raw ETH stake in wei
     * @return power sqrt(stake / 1e9) expressed as an integer (gwei-denominated sqrt)
     */
    function calculate(uint256 stake) external pure returns (uint256 power);

    /**
     * @notice Calculate total voting power for an account including delegated stake
     * @param account The address to query
     * @param stakedBalance Own stake in wei
     * @param delegatedStake Additional stake delegated to this account in wei
     * @return power Combined quadratic voting power
     */
    function calculateWithDelegation(
        address account,
        uint256 stakedBalance,
        uint256 delegatedStake
    ) external pure returns (uint256 power);

    /**
     * @notice Return the total voting power in the system given total staked ETH
     * @param totalStake Total staked ETH in wei
     * @return totalPower Sum of all individual quadratic powers (approximation)
     */
    function totalVotingPower(uint256 totalStake) external pure returns (uint256 totalPower);
}
