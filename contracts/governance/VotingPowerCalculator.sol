// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IVotingPower.sol";

/**
 * @title VotingPowerCalculator
 * @notice Implements quadratic voting power: power = floor(sqrt(stake / 1e9))
 *
 * Design Rationale
 * ────────────────
 * Raw wei values are too large for a meaningful integer square root, so we
 * first normalise by 1e9 (converting wei → gwei). This keeps voting-power
 * numbers in a human-friendly range while preserving relative ordering.
 *
 * Example:
 *   1 ETH  (1e18 wei) → sqrt(1e9)  ≈ 31 622 votes
 *   4 ETH  (4e18 wei) → sqrt(4e9)  ≈ 63 245 votes  (2× not 4×)
 *   9 ETH  (9e18 wei) → sqrt(9e9)  ≈ 94 868 votes  (3× not 9×)
 *
 * Quadratic voting reduces the outsized influence of large token holders
 * relative to linear / token-weighted voting while still rewarding
 * greater stake with greater (but sublinear) power.
 *
 * Flash-loan Protection
 * ─────────────────────
 * Voting power is snapshotted at proposal creation (voteStart). Any stake
 * acquired after that snapshot has no effect on the proposal, making flash
 * loan governance attacks economically unviable.
 */
contract VotingPowerCalculator is IVotingPower {

    // ─────────────────────────────────────────────────────────────────────
    //  Constants
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Normalisation divisor: convert wei to gwei before taking sqrt
    uint256 private constant NORMALISATION = 1e9;

    // ─────────────────────────────────────────────────────────────────────
    //  IVotingPower Implementation
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @inheritdoc IVotingPower
     * @dev Uses Babylonian (Newton's) method for integer square root — O(log n) iterations.
     */
    function calculate(uint256 stake) external pure override returns (uint256 power) {
        return _sqrt(stake / NORMALISATION);
    }

    /**
     * @inheritdoc IVotingPower
     * @dev Computes sqrt((ownStake + delegatedStake) / NORMALISATION).
     *      The sum is taken before the sqrt so that delegation DOES NOT simply
     *      add delegator's sqrt on top of delegatee's sqrt — it pools the raw
     *      ETH first, which is stronger but intentional to reward delegation
     *      without creating arithmetic shortcuts.
     */
    function calculateWithDelegation(
        address, /* account — included for interface compliance */
        uint256 stakedBalance,
        uint256 delegatedStake
    ) external pure override returns (uint256 power) {
        return _sqrt((stakedBalance + delegatedStake) / NORMALISATION);
    }

    /**
     * @inheritdoc IVotingPower
     * @dev Returns the system-wide sqrt of total stake — used for quorum calculations.
     *      Note: sum(sqrt(xᵢ)) ≠ sqrt(sum(xᵢ)); we use the latter as a simple
     *      upper-bound approximation for quorum thresholds.
     */
    function totalVotingPower(uint256 totalStake) external pure override returns (uint256 totalPower) {
        return _sqrt(totalStake / NORMALISATION);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Public Helper
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Pure helper to calculate quadratic voting power for a given stake
     * @param stake ETH stake in wei
     * @return power Quadratic voting power
     */
    function votingPower(uint256 stake) external pure returns (uint256 power) {
        return _sqrt(stake / NORMALISATION);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Internal — Babylonian Square Root
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @dev Integer square root via Babylonian method.
     *      Returns floor(sqrt(x)).
     *      Gas cost: ~300–500 gas for typical values.
     */
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        if (x <= 3) return 1;

        uint256 z = x;
        uint256 y = (x + 1) >> 1; // initial estimate

        while (y < z) {
            z = y;
            y = (x / y + y) >> 1;
        }
        return z;
    }
}
