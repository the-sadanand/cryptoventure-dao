// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../governance/GovernanceTypes.sol";

/**
 * @title IGovernance
 * @notice Interface for the CryptoVentures DAO governance contract
 */
interface IGovernance {
    // ─────────────────────────────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────────────────────────────

    event Deposit(address indexed depositor, uint256 amount, uint256 newStake);

    event Withdrawal(address indexed staker, uint256 amount, uint256 newStake);

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        GovernanceTypes.ProposalType proposalType,
        address recipient,
        uint256 amount,
        uint64 voteStart,
        uint64 voteEnd,
        string description
    );

    event VoteCast(
        address indexed voter,
        uint256 indexed proposalId,
        GovernanceTypes.VoteType support,
        uint256 votes,
        string reason
    );

    event DelegationChanged(
        address indexed delegator,
        address indexed fromDelegate,
        address indexed toDelegate
    );

    event ProposalQueued(uint256 indexed proposalId, uint64 executionETA);

    event ProposalExecuted(uint256 indexed proposalId);

    event ProposalCancelled(uint256 indexed proposalId, address cancelledBy);

    event EmergencyPause(address indexed by);

    event EmergencyUnpause(address indexed by);

    // ─────────────────────────────────────────────────────────────────────
    //  Staking
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Deposit ETH to gain voting power
    function deposit() external payable;

    /// @notice Withdraw staked ETH (subject to no active votes)
    function withdraw(uint256 amount) external;

    // ─────────────────────────────────────────────────────────────────────
    //  Delegation
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Delegate voting power to another address
    function delegate(address delegatee) external;

    /// @notice Revoke delegation and reclaim own voting power
    function undelegate() external;

    // ─────────────────────────────────────────────────────────────────────
    //  Proposals
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Create a new funding proposal
    function propose(
        GovernanceTypes.ProposalType proposalType,
        address payable recipient,
        uint256 amount,
        string calldata description
    ) external returns (uint256 proposalId);

    /// @notice Cast a vote on a proposal
    function castVote(
        uint256 proposalId,
        GovernanceTypes.VoteType support,
        string calldata reason
    ) external;

    /// @notice Move a succeeded proposal into the timelock queue
    function queue(uint256 proposalId) external;

    /// @notice Execute a queued proposal after the timelock delay
    function execute(uint256 proposalId) external;

    /// @notice Cancel a proposal (proposer or guardian only)
    function cancel(uint256 proposalId) external;

    // ─────────────────────────────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Get current on-chain state of a proposal
    function state(uint256 proposalId) external view returns (GovernanceTypes.ProposalState);

    /// @notice Get the vote receipt for a specific voter on a proposal
    function getReceipt(uint256 proposalId, address voter) external view returns (GovernanceTypes.VoteReceipt memory);

    /// @notice Get full proposal data
    function getProposal(uint256 proposalId) external view returns (GovernanceTypes.Proposal memory);

    /// @notice Get staked balance for an account
    function stakedBalance(address account) external view returns (uint256);

    /// @notice Get the current effective delegate for an account
    function delegates(address account) external view returns (address);

    /// @notice Get quadratic voting power of an account (optionally at a past snapshot)
    function getVotingPower(address account) external view returns (uint256);
}
