// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GovernanceTypes
 * @notice Shared types, enums, and structs for the CryptoVentures DAO governance system
 */
library GovernanceTypes {
    // ─────────────────────────────────────────────────────────────────────
    //  Enums
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Proposal types with different approval thresholds and treasury limits
    enum ProposalType {
        HighConviction, // 60% approval, 40% quorum, 7-day timelock, 60% treasury
        Experimental,   // 50% approval, 25% quorum, 3-day timelock, 30% treasury
        Operational     // 50% approval, 15% quorum, 1-day timelock, 10% treasury
    }

    /// @notice Lifecycle states for a proposal
    enum ProposalState {
        Pending,   // Created but voting hasn't started
        Active,    // Voting is open
        Defeated,  // Failed quorum or approval threshold
        Succeeded, // Passed — awaiting queue
        Queued,    // In timelock
        Executed,  // Successfully executed
        Cancelled, // Cancelled by proposer or guardian
        Expired    // Queued but not executed within expiry window
    }

    /// @notice Individual vote choice
    enum VoteType {
        Against,
        For,
        Abstain
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Structs
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Core proposal data structure
     * @dev Packed carefully to minimise storage slots
     */
    struct Proposal {
        uint256 id;
        address proposer;
        ProposalType proposalType;
        ProposalState state;
        // Voting window
        uint64 voteStart;       // block.timestamp when voting opens
        uint64 voteEnd;         // block.timestamp when voting closes
        // Timelock
        uint64 queuedAt;        // block.timestamp when queued
        uint64 executionETA;    // earliest execution block.timestamp
        // Vote tallies (quadratic weights)
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        // Snapshot — total voting power at voteStart
        uint256 totalVotingPowerSnapshot;
        // Treasury request
        address payable recipient;
        uint256 amount;         // ETH in wei
        // Metadata
        string description;
        bytes32 descriptionHash;
        // Anti-double-execution guard
        bool executed;
        bool cancelled;
    }

    /**
     * @notice Per-voter receipt stored on-chain
     */
    struct VoteReceipt {
        bool hasVoted;
        VoteType support;
        uint256 votes; // quadratic weight used
    }

    /**
     * @notice Parameters per proposal type — stored once at deploy, read-only afterwards
     */
    struct ProposalTypeConfig {
        uint16 approvalBPS;          // e.g. 6000 = 60%
        uint16 quorumBPS;            // e.g. 4000 = 40%
        uint32 timelockSeconds;      // seconds
        uint16 maxTreasuryAllocBPS;  // e.g. 6000 = 60%
        uint32 votingPeriodSeconds;  // seconds
    }
}
