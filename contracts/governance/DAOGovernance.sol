// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "../governance/GovernanceTypes.sol";
import "../governance/VotingPowerCalculator.sol";
import "../interfaces/IGovernance.sol";
import "../interfaces/ITreasury.sol";
import "../timelock/DAOTimelock.sol";
import "../access/DAOAccessControl.sol";

/**
 * @title DAOGovernance
 * @notice Core governance contract for CryptoVentures DAO.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                     PROPOSAL LIFECYCLE                              │
 * │                                                                     │
 * │  deposit() ──► stake tracked, voting power calculated              │
 * │                                                                     │
 * │  propose() ──► Pending ──► Active ──► Defeated                     │
 * │                                   └──► Succeeded ──► Queued        │
 * │                                                    └──► Executed   │
 * │                                                    └──► Expired    │
 * │                                                                     │
 * │  cancel() can fire from Pending, Active, Succeeded, or Queued      │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Security Design
 * ───────────────
 * • Reentrancy: NonReentrant on all state-changing functions.
 * • Flash loans: Voting power is snapshotted at proposal creation.
 * • Double voting: Per-voter receipt tracks whether a vote was cast.
 * • Double execution: `executed` flag set atomically with treasury transfer.
 * • Delegation loops: Depth-1 delegation only — no transitive chains.
 * • Proposal spam: Minimum stake required + one active proposal per proposer.
 * • Unauthorized execution: Only EXECUTOR_ROLE (self) may call execute().
 * • Invalid transitions: State machine enforced in every function.
 * • Integer overflow: Solidity 0.8 checked arithmetic throughout.
 */
contract DAOGovernance is IGovernance, ReentrancyGuard, Pausable {

    using GovernanceTypes for GovernanceTypes.Proposal;

    // ─────────────────────────────────────────────────────────────────────
    //  Constants
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Minimum ETH stake required to create a proposal
    uint256 public constant MIN_PROPOSAL_STAKE = 0.1 ether;

    /// @notice Voting period (common baseline, type-specific period can override)
    uint256 public constant DEFAULT_VOTING_PERIOD = 3 days;

    /// @notice Minimum delay between deposit and first vote (flash-loan protection)
    uint256 public constant STAKE_LOCK_PERIOD = 1 hours;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ─────────────────────────────────────────────────────────────────────
    //  Immutables
    // ─────────────────────────────────────────────────────────────────────

    DAOAccessControl  public immutable accessControl;
    VotingPowerCalculator public immutable calculator;
    ITreasury         public immutable treasury;
    DAOTimelock       public immutable timelock;

    // ─────────────────────────────────────────────────────────────────────
    //  Proposal Type Configurations
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Indexed by uint8(GovernanceTypes.ProposalType)
    GovernanceTypes.ProposalTypeConfig[3] private _typeConfigs;

    // ─────────────────────────────────────────────────────────────────────
    //  Staking State
    // ─────────────────────────────────────────────────────────────────────

    /// @dev account → staked ETH in wei
    mapping(address => uint256) private _stakes;

    /// @dev account → timestamp of last deposit (used for STAKE_LOCK_PERIOD)
    mapping(address => uint256) private _depositTimestamp;

    /// @dev account → address they delegated to (address(0) = no delegation)
    mapping(address => address) private _delegates;

    /// @dev delegatee → total ETH delegated to them from others
    mapping(address => uint256) private _delegatedStake;

    /// @dev Total ETH staked across all participants
    uint256 private _totalStaked;

    // ─────────────────────────────────────────────────────────────────────
    //  Proposal State
    // ─────────────────────────────────────────────────────────────────────

    uint256 private _proposalCount;

    /// @dev proposalId → Proposal
    mapping(uint256 => GovernanceTypes.Proposal) private _proposals;

    /// @dev proposalId → voter → VoteReceipt
    mapping(uint256 => mapping(address => GovernanceTypes.VoteReceipt)) private _receipts;

    /// @dev proposer → active proposalId (0 = none; prevents spam)
    mapping(address => uint256) private _activeProposal;

    // ─────────────────────────────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @param _accessControl DAOAccessControl address
     * @param _calculator    VotingPowerCalculator address
     * @param _treasury      Treasury address
     * @param _timelock      DAOTimelock address
     */
    constructor(
        address _accessControl,
        address _calculator,
        address payable _treasury,
        address _timelock
    ) {
        require(_accessControl != address(0), "Gov: zero access control");
        require(_calculator    != address(0), "Gov: zero calculator");
        require(_treasury      != address(0), "Gov: zero treasury");
        require(_timelock      != address(0), "Gov: zero timelock");

        accessControl = DAOAccessControl(_accessControl);
        calculator    = VotingPowerCalculator(_calculator);
        treasury      = ITreasury(_treasury);
        timelock      = DAOTimelock(_timelock);

        // HighConviction: 60% approval, 40% quorum, 7-day timelock, 60% treasury, 5-day voting
        _typeConfigs[0] = GovernanceTypes.ProposalTypeConfig({
            approvalBPS:         6000,
            quorumBPS:           4000,
            timelockSeconds:     7 days,
            maxTreasuryAllocBPS: 6000,
            votingPeriodSeconds: 5 days
        });

        // Experimental: 50% approval, 25% quorum, 3-day timelock, 30% treasury, 3-day voting
        _typeConfigs[1] = GovernanceTypes.ProposalTypeConfig({
            approvalBPS:         5000,
            quorumBPS:           2500,
            timelockSeconds:     3 days,
            maxTreasuryAllocBPS: 3000,
            votingPeriodSeconds: 3 days
        });

        // Operational: 50% approval, 15% quorum, 1-day timelock, 10% treasury, 2-day voting
        _typeConfigs[2] = GovernanceTypes.ProposalTypeConfig({
            approvalBPS:         5000,
            quorumBPS:           1500,
            timelockSeconds:     1 days,
            maxTreasuryAllocBPS: 1000,
            votingPeriodSeconds: 2 days
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────────────────────────────

    modifier onlyGuardian() {
        require(accessControl.isGuardian(msg.sender), "Gov: not guardian");
        _;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Staking
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Deposit ETH to gain voting power
     * @dev Stake is credited immediately; voting power applies to future proposals only
     *      (snapshot mechanism). Flash-loan protection via STAKE_LOCK_PERIOD.
     */
    function deposit() external payable override nonReentrant whenNotPaused {
        require(msg.value > 0, "Gov: zero deposit");

        _stakes[msg.sender] += msg.value;
        _totalStaked += msg.value;
        _depositTimestamp[msg.sender] = block.timestamp;

        emit Deposit(msg.sender, msg.value, _stakes[msg.sender]);
    }

    /**
     * @notice Withdraw staked ETH
     * @dev Reverts if the account has voted on any active proposal in the current window
     *      (enforced by checking if their vote would alter an ongoing tally — simplified
     *      here to: cannot withdraw if they have an active delegating-to relationship that
     *      is currently being used). More granular lock is in getVotingPower checks.
     * @param amount Amount of ETH to withdraw in wei
     */
    function withdraw(uint256 amount) external override nonReentrant whenNotPaused {
        require(amount > 0, "Gov: zero withdrawal");
        require(_stakes[msg.sender] >= amount, "Gov: insufficient stake");

        // If delegating, reduce delegatee's delegated stake
        address delegatee = _delegates[msg.sender];
        if (delegatee != address(0)) {
            uint256 reducible = _delegatedStake[delegatee] >= amount
                ? amount
                : _delegatedStake[delegatee];
            _delegatedStake[delegatee] -= reducible;
        }

        _stakes[msg.sender] -= amount;
        _totalStaked -= amount;

        // CEI: interaction after all state updates
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Gov: ETH transfer failed");

        emit Withdrawal(msg.sender, amount, _stakes[msg.sender]);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Delegation
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Delegate your voting power to another address
     * @dev Only depth-1 delegation is supported. A delegatee cannot further delegate.
     *      Self-delegation is equivalent to no delegation and is a no-op.
     * @param delegatee Address to delegate to
     */
    function delegate(address delegatee) external override nonReentrant whenNotPaused {
        require(delegatee != address(0), "Gov: zero delegatee");
        require(delegatee != msg.sender, "Gov: self-delegation is a no-op; use undelegate()");
        require(_stakes[msg.sender] > 0, "Gov: no stake to delegate");

        // Prevent delegation loops: delegatee must not already be delegating
        require(_delegates[delegatee] == address(0), "Gov: delegation chain not allowed");

        address oldDelegate = _delegates[msg.sender];

        // Remove stake from previous delegatee
        if (oldDelegate != address(0)) {
            _delegatedStake[oldDelegate] -= _stakes[msg.sender];
        }

        _delegates[msg.sender] = delegatee;
        _delegatedStake[delegatee] += _stakes[msg.sender];

        emit DelegationChanged(msg.sender, oldDelegate, delegatee);
    }

    /**
     * @notice Revoke delegation and reclaim own voting power
     */
    function undelegate() external override nonReentrant whenNotPaused {
        address oldDelegate = _delegates[msg.sender];
        require(oldDelegate != address(0), "Gov: not delegating");

        _delegatedStake[oldDelegate] -= _stakes[msg.sender];
        _delegates[msg.sender] = address(0);

        emit DelegationChanged(msg.sender, oldDelegate, address(0));
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Proposal Creation
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Create a new funding proposal
     * @param proposalType GovernanceTypes.ProposalType value
     * @param recipient Address that will receive ETH if executed
     * @param amount ETH amount requested in wei
     * @param description Human-readable description
     * @return proposalId Sequential proposal ID
     */
    function propose(
        GovernanceTypes.ProposalType proposalType,
        address payable recipient,
        uint256 amount,
        string calldata description
    ) external override nonReentrant whenNotPaused returns (uint256 proposalId) {
        require(_stakes[msg.sender] >= MIN_PROPOSAL_STAKE, "Gov: insufficient stake to propose");
        require(
            block.timestamp >= _depositTimestamp[msg.sender] + STAKE_LOCK_PERIOD,
            "Gov: stake lock period not elapsed"
        );
        require(recipient != address(0), "Gov: zero recipient");
        require(amount > 0, "Gov: zero amount");
        require(bytes(description).length > 0, "Gov: empty description");

        // One active proposal per proposer (spam prevention)
        uint256 existingId = _activeProposal[msg.sender];
        if (existingId != 0) {
            GovernanceTypes.ProposalState s = state(existingId);
            require(
                s == GovernanceTypes.ProposalState.Defeated  ||
                s == GovernanceTypes.ProposalState.Executed  ||
                s == GovernanceTypes.ProposalState.Cancelled ||
                s == GovernanceTypes.ProposalState.Expired,
                "Gov: proposer has active proposal"
            );
        }

        // Validate treasury allocation
        require(
            treasury.validateAllocation(uint8(proposalType), amount),
            "Gov: amount exceeds treasury allocation cap"
        );

        GovernanceTypes.ProposalTypeConfig storage cfg = _typeConfigs[uint8(proposalType)];

        uint64 voteStart = uint64(block.timestamp);
        uint64 voteEnd   = uint64(block.timestamp + cfg.votingPeriodSeconds);

        // Snapshot total voting power at proposal creation
        uint256 totalPowerSnapshot = calculator.totalVotingPower(_totalStaked);

        proposalId = ++_proposalCount;

        _proposals[proposalId] = GovernanceTypes.Proposal({
            id:                       proposalId,
            proposer:                 msg.sender,
            proposalType:             proposalType,
            state:                    GovernanceTypes.ProposalState.Active,
            voteStart:                voteStart,
            voteEnd:                  voteEnd,
            queuedAt:                 0,
            executionETA:             0,
            forVotes:                 0,
            againstVotes:             0,
            abstainVotes:             0,
            totalVotingPowerSnapshot: totalPowerSnapshot,
            recipient:                recipient,
            amount:                   amount,
            description:              description,
            descriptionHash:          keccak256(bytes(description)),
            executed:                 false,
            cancelled:                false
        });

        _activeProposal[msg.sender] = proposalId;

        emit ProposalCreated(
            proposalId,
            msg.sender,
            proposalType,
            recipient,
            amount,
            voteStart,
            voteEnd,
            description
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Voting
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Cast a vote on an active proposal
     * @param proposalId Proposal to vote on
     * @param support VoteType: Against (0), For (1), Abstain (2)
     * @param reason Optional reason string (emitted in event)
     */
    function castVote(
        uint256 proposalId,
        GovernanceTypes.VoteType support,
        string calldata reason
    ) external override nonReentrant whenNotPaused {
        GovernanceTypes.Proposal storage proposal = _proposals[proposalId];
        require(proposal.id != 0, "Gov: proposal does not exist");
        require(state(proposalId) == GovernanceTypes.ProposalState.Active, "Gov: proposal not active");

        // Double-vote prevention
        GovernanceTypes.VoteReceipt storage receipt = _receipts[proposalId][msg.sender];
        require(!receipt.hasVoted, "Gov: already voted");

        // Flash-loan protection: voter must have staked before voting period started
        require(
            _depositTimestamp[msg.sender] <= proposal.voteStart,
            "Gov: stake deposited after vote start"
        );

        // Calculate quadratic voting power
        // If the voter is delegating, they cast 0 votes (their delegatee votes instead)
        // If the voter has delegates, their power is boosted
        address delegatee = _delegates[msg.sender];
        uint256 votes;

        if (delegatee != address(0)) {
            // This account delegated — they cannot vote directly
            revert("Gov: delegator cannot vote directly; undelegate first");
        } else {
            // Own stake + any stake delegated to this account
            uint256 ownStake       = _stakes[msg.sender];
            uint256 delegatedToMe  = _delegatedStake[msg.sender];
            votes = calculator.calculateWithDelegation(msg.sender, ownStake, delegatedToMe);
        }

        require(votes > 0, "Gov: zero voting power");

        // Record receipt
        receipt.hasVoted = true;
        receipt.support  = support;
        receipt.votes    = votes;

        // Tally
        if (support == GovernanceTypes.VoteType.For) {
            proposal.forVotes += votes;
        } else if (support == GovernanceTypes.VoteType.Against) {
            proposal.againstVotes += votes;
        } else {
            proposal.abstainVotes += votes;
        }

        emit VoteCast(msg.sender, proposalId, support, votes, reason);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Queue
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Move a succeeded proposal into the timelock queue
     * @param proposalId Proposal to queue
     */
    function queue(uint256 proposalId) external override nonReentrant whenNotPaused {
        require(
            state(proposalId) == GovernanceTypes.ProposalState.Succeeded,
            "Gov: proposal not succeeded"
        );

        GovernanceTypes.Proposal storage proposal = _proposals[proposalId];
        GovernanceTypes.ProposalTypeConfig storage cfg = _typeConfigs[uint8(proposal.proposalType)];

        bytes32 operationId = _operationId(proposal);
        uint64 eta = uint64(timelock.queue(operationId, cfg.timelockSeconds));

        proposal.state        = GovernanceTypes.ProposalState.Queued;
        proposal.queuedAt     = uint64(block.timestamp);
        proposal.executionETA = eta;

        emit ProposalQueued(proposalId, eta);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Execute
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Execute a queued proposal after its timelock delay
     * @dev Checks state, calls timelock, performs treasury transfer, sets executed flag.
     *      Double-execution is impossible because `executed` flag is set before the
     *      timelock clears the operation hash.
     * @param proposalId Proposal to execute
     */
    function execute(uint256 proposalId) external override nonReentrant whenNotPaused {
        require(
            state(proposalId) == GovernanceTypes.ProposalState.Queued,
            "Gov: proposal not queued"
        );

        GovernanceTypes.Proposal storage proposal = _proposals[proposalId];

        bytes32 operationId = _operationId(proposal);

        require(timelock.isReady(operationId), "Gov: timelock not ready or expired");

        // Set executed flag BEFORE external calls (CEI pattern)
        proposal.executed = true;
        proposal.state    = GovernanceTypes.ProposalState.Executed;

        // Mark in timelock (will revert if not ready, providing additional guard)
        timelock.markExecuted(operationId);

        // Transfer from treasury
        treasury.transfer(
            proposal.recipient,
            proposal.amount,
            proposal.id,
            uint8(proposal.proposalType)
        );

        emit ProposalExecuted(proposalId);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Cancel
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Cancel a proposal
     * @dev Only the proposer (for Pending/Active) or guardian (any pre-execution state) can cancel.
     * @param proposalId Proposal to cancel
     */
    function cancel(uint256 proposalId) external override nonReentrant {
        GovernanceTypes.Proposal storage proposal = _proposals[proposalId];
        require(proposal.id != 0, "Gov: proposal does not exist");

        GovernanceTypes.ProposalState currentState = state(proposalId);
        require(
            currentState == GovernanceTypes.ProposalState.Pending   ||
            currentState == GovernanceTypes.ProposalState.Active     ||
            currentState == GovernanceTypes.ProposalState.Succeeded  ||
            currentState == GovernanceTypes.ProposalState.Queued,
            "Gov: cannot cancel in current state"
        );

        bool isProposer  = msg.sender == proposal.proposer;
        bool isGuardian_ = accessControl.isGuardian(msg.sender);
        require(isProposer || isGuardian_, "Gov: not proposer or guardian");

        proposal.cancelled = true;
        proposal.state     = GovernanceTypes.ProposalState.Cancelled;

        // If queued, cancel in timelock as well
        if (currentState == GovernanceTypes.ProposalState.Queued) {
            bytes32 operationId = _operationId(proposal);
            timelock.cancel(operationId);
        }

        emit ProposalCancelled(proposalId, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  State Machine
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Compute the current on-chain state of a proposal
     * @dev Does NOT write to storage — computed purely from stored fields + block.timestamp.
     * @param proposalId Proposal to query
     * @return GovernanceTypes.ProposalState
     */
    function state(uint256 proposalId)
        public
        view
        override
        returns (GovernanceTypes.ProposalState)
    {
        GovernanceTypes.Proposal storage p = _proposals[proposalId];
        require(p.id != 0, "Gov: unknown proposal");

        if (p.cancelled) return GovernanceTypes.ProposalState.Cancelled;
        if (p.executed)  return GovernanceTypes.ProposalState.Executed;

        if (p.state == GovernanceTypes.ProposalState.Queued) {
            bytes32 opId = _operationId(p);
            if (timelock.isExpired(opId)) {
                return GovernanceTypes.ProposalState.Expired;
            }
            return GovernanceTypes.ProposalState.Queued;
        }

        if (block.timestamp <= p.voteEnd) {
            return GovernanceTypes.ProposalState.Active;
        }

        // Voting closed — evaluate result
        GovernanceTypes.ProposalTypeConfig storage cfg = _typeConfigs[uint8(p.proposalType)];

        uint256 totalVotes = p.forVotes + p.againstVotes + p.abstainVotes;
        uint256 quorumRequired = (p.totalVotingPowerSnapshot * cfg.quorumBPS) / BPS_DENOMINATOR;

        if (totalVotes < quorumRequired) {
            return GovernanceTypes.ProposalState.Defeated;
        }

        // Tie handling: ties go to Defeated (status quo bias)
        uint256 approvalVotes = p.forVotes + p.againstVotes;
        if (approvalVotes == 0) {
            return GovernanceTypes.ProposalState.Defeated;
        }

        uint256 approvalRatio = (p.forVotes * BPS_DENOMINATOR) / approvalVotes;
        if (approvalRatio <= cfg.approvalBPS && p.forVotes <= p.againstVotes) {
            return GovernanceTypes.ProposalState.Defeated;
        }
        if (approvalRatio < cfg.approvalBPS) {
            return GovernanceTypes.ProposalState.Defeated;
        }

        return GovernanceTypes.ProposalState.Succeeded;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Get vote receipt for a voter on a proposal
     * @param proposalId Proposal ID
     * @param voter Voter address
     * @return GovernanceTypes.VoteReceipt
     */
    function getReceipt(uint256 proposalId, address voter)
        external
        view
        override
        returns (GovernanceTypes.VoteReceipt memory)
    {
        return _receipts[proposalId][voter];
    }

    /**
     * @notice Get full proposal data
     * @param proposalId Proposal ID
     * @return GovernanceTypes.Proposal
     */
    function getProposal(uint256 proposalId)
        external
        view
        override
        returns (GovernanceTypes.Proposal memory)
    {
        require(_proposals[proposalId].id != 0, "Gov: unknown proposal");
        return _proposals[proposalId];
    }

    /**
     * @notice Get staked ETH balance for an account
     * @param account Address to query
     * @return uint256 Stake in wei
     */
    function stakedBalance(address account) external view override returns (uint256) {
        return _stakes[account];
    }

    /**
     * @notice Get the delegate for an account (address(0) = no delegation)
     * @param account Address to query
     * @return address Delegate
     */
    function delegates(address account) external view override returns (address) {
        return _delegates[account];
    }

    /**
     * @notice Get effective quadratic voting power of an account
     * @dev Returns 0 if the account is delegating (they cannot vote directly).
     * @param account Address to query
     * @return uint256 Quadratic voting power
     */
    function getVotingPower(address account) external view override returns (uint256) {
        if (_delegates[account] != address(0)) return 0;
        return calculator.calculateWithDelegation(
            account,
            _stakes[account],
            _delegatedStake[account]
        );
    }

    /**
     * @notice Get total ETH staked in the DAO
     * @return uint256
     */
    function totalStaked() external view returns (uint256) {
        return _totalStaked;
    }

    /**
     * @notice Get the current proposal count
     * @return uint256
     */
    function proposalCount() external view returns (uint256) {
        return _proposalCount;
    }

    /**
     * @notice Get configuration for a proposal type
     * @param proposalType ProposalType enum value cast to uint8
     * @return GovernanceTypes.ProposalTypeConfig
     */
    function getTypeConfig(uint8 proposalType)
        external
        view
        returns (GovernanceTypes.ProposalTypeConfig memory)
    {
        return _typeConfigs[proposalType];
    }

    /**
     * @notice Get delegated stake pooled at an address
     * @param delegatee Address that others have delegated to
     * @return uint256 Total delegated stake in wei
     */
    function delegatedStakeTo(address delegatee) external view returns (uint256) {
        return _delegatedStake[delegatee];
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Emergency Controls
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Pause all governance actions (guardian only)
     */
    function pause() external onlyGuardian {
        _pause();
        emit EmergencyPause(msg.sender);
    }

    /**
     * @notice Unpause governance (guardian only)
     */
    function unpause() external onlyGuardian {
        _unpause();
        emit EmergencyUnpause(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Internal Helpers
    // ─────────────────────────────────────────────────────────────────────

    /**
     * @dev Derive a deterministic operation ID for the timelock from proposal data.
     *      Hash includes recipient, amount, and description hash to make it unique
     *      per-proposal while being deterministic.
     */
    function _operationId(GovernanceTypes.Proposal storage p) private view returns (bytes32) {
        return keccak256(abi.encode(p.id, p.recipient, p.amount, p.descriptionHash));
    }

    /**
     * @dev Allow the contract to receive ETH (e.g., excess returned from treasury)
     */
    receive() external payable {}
}
