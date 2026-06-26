# Security Policy — CryptoVentures DAO

## Threat Model

CryptoVentures DAO manages a live ETH treasury and controls governance decisions via on-chain proposals and voting. The primary assets at risk are:

1. The ETH held in the Treasury contract
2. The legitimacy and integrity of governance outcomes
3. Voting power distribution (fairness)

Adversaries range from passive opportunists (flash loan bots, copy-paste attackers) to sophisticated state-level actors who may acquire large stake to influence governance.

---

## Attack Vectors & Mitigations

### 1. Flash Loan Governance Attack

**Vector:** An attacker borrows large ETH via a flash loan, deposits into the DAO within a single transaction to gain massive voting power, votes on a pre-created proposal, then repays the loan — all atomically.

**Mitigation:**
- `STAKE_LOCK_PERIOD = 1 hour`: At least 1 hour must pass between deposit and the first eligible proposal vote. Flash loans are repaid within the same transaction (or at most one block), making them ineffective.
- Voting power is snapshotted at `proposal.voteStart`. Stake acquired after this timestamp contributes zero power to the proposal.
- Check in `castVote`: `require(_depositTimestamp[msg.sender] <= proposal.voteStart, ...)`.

**Residual Risk:** An attacker who holds ETH for > 1 hour before the proposal is created can use it for voting. This is normal staker behaviour and is addressed by the quorum and approval thresholds rather than by lock periods.

---

### 2. Reentrancy Attack

**Vector:** A malicious ETH recipient contract calls back into `DAOGovernance.execute()` or `Treasury.transfer()` before state is finalised, executing the proposal twice or draining the treasury.

**Mitigation:**
- All state-changing functions in `DAOGovernance` and `Treasury` are decorated with OpenZeppelin's `ReentrancyGuard` (`nonReentrant` modifier).
- The `executed` flag is set to `true` and `proposal.state` set to `Executed` **before** the external `Treasury.transfer()` call (Checks-Effects-Interactions pattern).
- `Treasury.transfer()` is itself `nonReentrant`.
- `DAOTimelock.markExecuted()` clears the operation hash before returning, ensuring no re-entry can find the operation in a valid state.

---

### 3. Proposal Spam Attack

**Vector:** An attacker floods the system with many proposals to exhaust indexing, gas, or governance attention.

**Mitigation:**
- `MIN_PROPOSAL_STAKE = 0.1 ETH`: Proposers must have meaningful skin in the game.
- `STAKE_LOCK_PERIOD = 1 hour`: Stake must be held for at least 1 hour before proposing.
- **One active proposal per proposer**: `_activeProposal[proposer]` tracks the current proposal; a second proposal from the same address reverts until the first reaches a terminal state.

---

### 4. Double Voting

**Vector:** A voter attempts to cast more than one vote on the same proposal (e.g., vote FOR, then also vote AGAINST).

**Mitigation:**
- `VoteReceipt.hasVoted` is stored per-voter per-proposal. The first vote sets this to `true`; subsequent calls revert with `"Gov: already voted"`.

---

### 5. Double Execution

**Vector:** An attacker (or bug) attempts to execute the same proposal twice, draining the treasury twice.

**Mitigation:**
- `proposal.executed` is a boolean set to `true` before any external calls. The `state()` function returns `Executed` for such proposals; `execute()` requires `state == Queued`, so re-execution reverts.
- `DAOTimelock` clears the operation hash when `markExecuted()` is called. Any attempt to re-call `markExecuted()` finds `queuedOperations[operationId] == 0` and reverts.

---

### 6. Delegation Loop Attack

**Vector:** Alice delegates to Bob, Bob delegates to Alice, creating a loop that inflates voting power.

**Mitigation:**
- Only **depth-1 delegation** is supported. When Alice tries to delegate to Bob, the contract checks `require(_delegates[delegatee] == address(0), "Gov: delegation chain not allowed")`. If Bob is already delegating to anyone, Alice cannot delegate to Bob.
- This prevents all 2-hop (and by extension N-hop) delegation loops with O(1) cost.

---

### 7. Invalid State Transitions

**Vector:** An attacker attempts to queue a defeated proposal, execute an active proposal, or otherwise drive the state machine into an invalid state.

**Mitigation:**
- `queue()` requires `state(proposalId) == Succeeded`.
- `execute()` requires `state(proposalId) == Queued` (which also checks timelock is ready and not expired).
- `cancel()` requires state in `{Pending, Active, Succeeded, Queued}`.
- The `state()` function is a pure view computed from stored fields and `block.timestamp` — it cannot be manipulated by calling contract functions in a non-standard order.

---

### 8. Unauthorized Execution

**Vector:** An external account calls `DAOTimelock.markExecuted()` or `Treasury.transfer()` directly, bypassing governance.

**Mitigation:**
- `DAOTimelock.queue/markExecuted/cancel` all require `EXECUTOR_ROLE`, which is granted **only** to `DAOGovernance`.
- `Treasury.transfer()` requires `TREASURER_ROLE`, granted **only** to `DAOGovernance`.
- These roles are managed by `DAOAccessControl` which inherits from OpenZeppelin's battle-tested `AccessControl`.

---

### 9. Unauthorized Cancellation

**Vector:** An attacker cancels another user's valid proposal.

**Mitigation:**
- `cancel()` checks `msg.sender == proposal.proposer || accessControl.isGuardian(msg.sender)`. Any other caller reverts with `"Gov: not proposer or guardian"`.

---

### 10. Integer Overflow / Underflow

**Vector:** Arithmetic on large ETH values (wei) overflows, corrupting vote counts or balances.

**Mitigation:**
- Solidity ^0.8.20 has built-in checked arithmetic. All overflow/underflow reverts automatically.
- The `VotingPowerCalculator` normalises by `1e9` before taking the integer square root, keeping values in the range `[0, ~31,622,776]` for typical staking amounts, well within `uint256`.

---

### 11. Treasury Drain Attack

**Vector:** A compromised or colluding majority passes a HighConviction proposal draining 100% of the treasury.

**Mitigation:**
- **Per-type allocation caps** enforced at both proposal creation and execution:
  - HighConviction: 60% per proposal
  - Experimental: 30% per proposal
  - Operational: 10% per proposal
- Caps are denominated as a **percentage of current balance**, not absolute amounts. As the treasury shrinks, subsequent proposals can drain less.
- Each proposal type has a different timelock, giving the community and guardian time to respond before execution.
- The guardian can cancel queued proposals during the timelock window.

---

## Access Control Review

| Role | Holder | Capabilities |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Deployer multisig | Grant/revoke all roles; update treasury caps |
| `GUARDIAN_ROLE` | Guardian multisig | Pause governance; pause treasury; cancel proposals |
| `EXECUTOR_ROLE` | DAOGovernance only | Queue/execute/cancel in DAOTimelock |
| `TREASURER_ROLE` | DAOGovernance only | Transfer ETH from Treasury |

**Production Recommendation:** Immediately after deployment, transfer `DEFAULT_ADMIN_ROLE` from the deployer EOA to a Gnosis Safe multisig requiring at least 3-of-5 signers. The guardian should be a separate 2-of-3 multisig with a different key set.

---

## Governance Attack Analysis

### 51% Attack

If an attacker accumulates >50% of total voting power (under quadratic weighting, this requires controlling a disproportionate fraction of total ETH staked), they can:
- Pass Experimental and Operational proposals (50% threshold)
- Pass HighConviction proposals (60% threshold) with ~77% of quadratic power

**Timelock defense:** Even with majority control, the attacker must wait 1–7 days per proposal. During this window, the community can respond, the guardian can pause, and other stakers can withdraw and take action externally.

**Economic defense:** Quadratic voting means that to achieve 60% of voting power, an attacker needs to control roughly 36% of total staked ETH (since power grows as sqrt). This is a significant economic commitment.

---

## Flash Loan Analysis

See Section 1 above. Key insight: the 1-hour `STAKE_LOCK_PERIOD` is sufficient for same-block and same-session flash loans. For protocols concerned about slow-flash-loan attacks (multi-block positions), consider extending `STAKE_LOCK_PERIOD` to 24–48 hours.

---

## Reentrancy Analysis

The contract follows strict CEI (Checks-Effects-Interactions):

```
execute():
  1. CHECK:  state == Queued
  2. CHECK:  timelock.isReady()
  3. EFFECT: proposal.executed = true
  4. EFFECT: proposal.state = Executed
  5. INTERACT: timelock.markExecuted()  ← clears timelock state
  6. INTERACT: treasury.transfer()      ← sends ETH
```

Even if the recipient contract at step 6 re-enters `execute()`, step 1 will fail because `proposal.executed = true` causes `state()` to return `Executed`, not `Queued`.

The `nonReentrant` modifier provides an additional guard at the function level, reverting immediately if `execute()` is called while already in `execute()`.

---

## Known Limitations

1. **Approximate quorum denominator**: `totalVotingPowerSnapshot` uses `sqrt(totalStaked)` at proposal creation. Individual user stakes may change during the voting period, making the quorum denominator approximate rather than exact.

2. **No stake withdrawal lock during active votes**: A user can theoretically stake, vote, and withdraw in consecutive blocks. Because the vote is already recorded and the voting power snapshot is taken at proposal creation, this does not affect the vote tally — but it does allow capital to be freed. For protocols concerned about this, consider a withdrawal lock during the voting period.

3. **Guardian is trusted**: The guardian role is a centralisation point. Guardian can unilaterally pause governance or cancel proposals. This is intentional as an emergency mechanism but should be held by a decentralised multisig in production.

4. **No on-chain proposal text storage optimisation**: The full description string is stored on-chain, which is expensive for long descriptions. A production system might store only a content hash and use IPFS for the full text.

---

## Reporting a Vulnerability

Please report security vulnerabilities via private disclosure to security@cryptoventures-dao.example. Do not open public GitHub issues for security findings. We target a 48-hour acknowledgement and 7-day remediation timeline for critical issues.
