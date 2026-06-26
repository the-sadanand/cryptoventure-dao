# CryptoVentures DAO

> Decentralized Investment Fund Governance System with Multi-Tier Treasury Management

A production-grade, security-first DAO governance system built in Solidity ^0.8.20 with OpenZeppelin v5. Implements quadratic voting, multi-tier treasury allocation controls, a custom timelock, delegation, and a full proposal lifecycle — tested with a comprehensive suite targeting 95%+ coverage.

---

## Table of Contents

- [Architecture](#architecture)
- [Contract Overview](#contract-overview)
- [Proposal Types](#proposal-types)
- [Governance Features](#governance-features)
- [Setup & Installation](#setup--installation)
- [Deployment](#deployment)
- [Testing](#testing)
- [Usage Examples](#usage-examples)
- [Security Considerations](#security-considerations)
- [Design Tradeoffs](#design-tradeoffs)
- [Future Improvements](#future-improvements)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      CryptoVentures DAO                              │
│                                                                      │
│   User (staker/proposer/voter)                                       │
│       │                                                              │
│       ▼                                                              │
│  ┌────────────────────┐     ┌──────────────────────┐                │
│  │   DAOGovernance    │────▶│   DAOAccessControl   │                │
│  │  (core logic)      │     │  (role registry)     │                │
│  └────────┬───────────┘     └──────────────────────┘                │
│           │                                                          │
│     ┌─────┴──────────────────────┐                                  │
│     │                            │                                  │
│     ▼                            ▼                                  │
│  ┌──────────────┐      ┌──────────────────────┐                     │
│  │  DAOTimelock │      │      Treasury         │                     │
│  │  (queue/ETA) │      │  (ETH custodian)      │                     │
│  └──────────────┘      └──────────────────────┘                     │
│                                                                      │
│  ┌──────────────────────────┐                                        │
│  │  VotingPowerCalculator   │  (pure, stateless)                     │
│  │  sqrt(stake / 1e9)       │                                        │
│  └──────────────────────────┘                                        │
└──────────────────────────────────────────────────────────────────────┘
```

### Contract Interaction Diagram

```
deposit(ETH)
    │
    ▼
DAOGovernance._stakes[user] += amount
DAOGovernance._totalStaked  += amount

propose(type, recipient, amount, desc)
    │
    ├── validates: MIN_PROPOSAL_STAKE, STAKE_LOCK_PERIOD, treasury cap
    ├── snapshots: totalVotingPower at voteStart
    └── stores:    Proposal struct

castVote(proposalId, support, reason)
    │
    ├── reads:  VotingPowerCalculator.calculateWithDelegation()
    ├── checks: receipt.hasVoted == false
    └── writes: forVotes / againstVotes / abstainVotes

queue(proposalId)
    │
    ├── checks: state == Succeeded
    └── calls:  DAOTimelock.queue(operationId, timelockDelay)

execute(proposalId)
    │
    ├── checks: state == Queued, DAOTimelock.isReady()
    ├── sets:   proposal.executed = true  (CEI before external calls)
    ├── calls:  DAOTimelock.markExecuted(operationId)
    └── calls:  Treasury.transfer(recipient, amount, proposalId, type)
```

### Proposal Lifecycle State Machine

```
                    ┌──────────┐
        propose()   │          │
    ───────────────▶│  Active  │
                    │          │
                    └────┬─────┘
                         │
              voteEnd elapsed
                         │
             ┌───────────┴───────────┐
             │                       │
        quorum OK              quorum missed
        approval OK            OR approval failed
             │                       │
             ▼                       ▼
        ┌──────────┐          ┌──────────┐
        │Succeeded │          │ Defeated │
        └────┬─────┘          └──────────┘
             │
          queue()
             │
             ▼
        ┌──────────┐
        │  Queued  │──────── past grace period ──▶ Expired
        └────┬─────┘
             │
          execute()
          (after ETA)
             │
             ▼
        ┌──────────┐
        │ Executed │
        └──────────┘

  cancel() ──▶ Cancelled   (from Active, Succeeded, or Queued)
```

### Treasury Allocation Flow

```
Treasury (ETH pool)
    │
    ├── HighConviction proposals  → max 60% of balance per execution
    ├── Experimental proposals    → max 30% of balance per execution
    └── Operational proposals     → max 10% of balance per execution

Validation happens at:
  1. propose()   — snapshot check against current balance
  2. transfer()  — re-validates at execution time (balance may have changed)
```

### Voting Power Calculation

Quadratic voting reduces whale dominance. Formula:

```
votingPower(stake) = floor(sqrt(stake / 1e9))

Examples:
  1 ETH  (1e18 wei) → sqrt(1e9)  = 31,622 votes
  4 ETH  (4e18 wei) → sqrt(4e9)  = 63,245 votes  (2× power for 4× stake)
  9 ETH  (9e18 wei) → sqrt(9e9)  = 94,868 votes  (3× power for 9× stake)
 16 ETH  (16e18)    → sqrt(16e9) = 126,491 votes  (4× power for 16× stake)

With delegation:
  votingPower(delegatee) = sqrt((ownStake + delegatedStake) / 1e9)
  Stakes are pooled BEFORE the sqrt, which is stronger than summing individual sqrts.
```

### Security Model

| Threat                  | Mitigation                                                        |
|-------------------------|-------------------------------------------------------------------|
| Flash loan attacks      | STAKE_LOCK_PERIOD (1 hr) + vote snapshot at proposal creation     |
| Reentrancy              | ReentrancyGuard on all state-changing functions                   |
| Double voting           | VoteReceipt.hasVoted flag per voter per proposal                  |
| Double execution        | `proposal.executed` flag set before treasury call (CEI)           |
| Proposal spam           | MIN_PROPOSAL_STAKE + one-active-proposal-per-proposer limit       |
| Delegation loops        | Depth-1 delegation; delegatee cannot re-delegate                  |
| Treasury drain          | Per-type allocation caps enforced at propose + execute time       |
| Unauthorized execution  | Only EXECUTOR_ROLE (governance itself) can call timelock          |
| Integer overflow        | Solidity ^0.8.20 checked arithmetic                               |
| Emergency scenarios     | GUARDIAN_ROLE can pause governance + treasury, cancel proposals   |

### Role Model

```
DEFAULT_ADMIN_ROLE  (multisig)
    ├── grants / revokes all other roles
    ├── updates treasury allocation caps
    └── transfers admin to new multisig

GUARDIAN_ROLE
    ├── pause DAOGovernance
    ├── pause Treasury
    └── cancel any proposal

EXECUTOR_ROLE       (granted to DAOGovernance)
    ├── queue operations in DAOTimelock
    ├── mark operations executed in DAOTimelock
    └── cancel operations in DAOTimelock

TREASURER_ROLE      (granted to DAOGovernance)
    └── call Treasury.transfer()
```

---

## Contract Overview

| Contract | Path | Purpose |
|---|---|---|
| `GovernanceTypes` | `contracts/governance/GovernanceTypes.sol` | Shared enums, structs, types |
| `VotingPowerCalculator` | `contracts/governance/VotingPowerCalculator.sol` | Pure quadratic voting math |
| `DAOGovernance` | `contracts/governance/DAOGovernance.sol` | Core governance logic |
| `Treasury` | `contracts/treasury/Treasury.sol` | ETH custodian with allocation caps |
| `DAOTimelock` | `contracts/timelock/DAOTimelock.sol` | Operation scheduling / delay |
| `DAOAccessControl` | `contracts/access/DAOAccessControl.sol` | Role-based access control |
| `IGovernance` | `contracts/interfaces/IGovernance.sol` | Governance interface |
| `ITreasury` | `contracts/interfaces/ITreasury.sol` | Treasury interface |
| `IVotingPower` | `contracts/interfaces/IVotingPower.sol` | Voting power interface |

---

## Proposal Types

| Type | Approval | Quorum | Timelock | Max Treasury |
|---|---|---|---|---|
| HighConviction | 60% | 40% | 7 days | 60% |
| Experimental | 50% | 25% | 3 days | 30% |
| Operational | 50% | 15% | 1 day | 10% |

---

## Governance Features

- **ETH Staking** — Deposit ETH to gain voting power. Stake tracked per address.
- **Quadratic Voting** — Power grows as sqrt(stake), reducing whale dominance.
- **Delegation** — Delegate your stake to another voter (depth-1 only).
- **Vote For / Against / Abstain** — Three-way vote with separate tallies.
- **Proposal Creation** — Requires min stake + stake lock period elapsed.
- **Proposal Queue** — Succeeded proposals enter timelock before execution.
- **Proposal Execution** — ETH sent to recipient after timelock delay.
- **Proposal Cancellation** — Proposer or guardian can cancel at any pre-execution stage.
- **Proposal Expiration** — Queued proposals not executed within 14 days expire.
- **Snapshot Voting Power** — Power is snapshotted at proposal creation, preventing flash loan manipulation.
- **Historical Vote Receipts** — `getReceipt(proposalId, voter)` returns full vote record.

---

## Setup & Installation

### Prerequisites

- Node.js >= 18
- npm >= 9

### Install

```bash
git clone https://github.com/yourorg/cryptoventures-dao
cd cryptoventures-dao
npm install
cp .env.example .env
# Fill in .env values
```

---

## Deployment

### Local (Hardhat node)

```bash
# Terminal 1: start local node
npx hardhat node

# Terminal 2: deploy
npx hardhat run scripts/deploy.ts --network localhost
```

### Testnet (Sepolia)

```bash
# Ensure .env has PRIVATE_KEY and INFURA_API_KEY set
npx hardhat run scripts/deploy.ts --network sepolia
```

### What the deploy script does

1. Deploys `DAOAccessControl` with deployer as admin, guardian as guardian
2. Deploys `VotingPowerCalculator`
3. Deploys `Treasury`
4. Deploys `DAOTimelock`
5. Deploys `DAOGovernance`
6. Grants `EXECUTOR_ROLE` and `TREASURER_ROLE` to `DAOGovernance`
7. Seeds treasury with 10 ETH
8. Seeds two user stakes (1 ETH and 4 ETH)

---

## Testing

```bash
# Run all tests
npx hardhat test

# Run with gas reporting
REPORT_GAS=true npx hardhat test

# Run coverage
npx hardhat coverage

# Run a specific test file
npx hardhat test test/governance.test.ts
```

### Test Files

| File | Coverage |
|---|---|
| `governance.test.ts` | Staking, proposals, execute, cancel, pause |
| `voting.test.ts` | All vote types, quadratic math, tie handling |
| `delegation.test.ts` | Delegate, undelegate, loops, voting with delegation |
| `timelock.test.ts` | All three timelock delays, expiry, queue failures |
| `treasury.test.ts` | Deposits, caps, transfers, unauthorized, pause |
| `accesscontrol.test.ts` | Role assignment, management, constructor guards |
| `edgecases.test.ts` | Flash loans, double exec, reentrancy, spam, quorum |

---

## Usage Examples

### Stake and vote

```typescript
// Stake 2 ETH
await governance.deposit({ value: ethers.parseEther("2") });

// Wait 1 hour (stake lock period)

// Create a proposal
const tx = await governance.propose(
  0,                             // HighConviction
  recipientAddress,
  ethers.parseEther("5"),        // 5 ETH
  "Fund new DeFi protocol audit"
);

// Vote FOR
await governance.castVote(proposalId, 1, "This is well-scoped");

// After voting period + timelock
await governance.queue(proposalId);
// ... wait timelock delay ...
await governance.execute(proposalId);
```

### Delegation

```typescript
// Delegate voting power to a trusted voter
await governance.delegate(trustedVoterAddress);

// Revoke delegation
await governance.undelegate();
```

### Check proposal state

```typescript
const stateNum = await governance.state(proposalId);
// 0=Pending, 1=Active, 2=Defeated, 3=Succeeded, 4=Queued, 5=Executed, 6=Cancelled, 7=Expired

const receipt = await governance.getReceipt(proposalId, voterAddress);
console.log(receipt.hasVoted, receipt.support, receipt.votes);
```

---

## Security Considerations

See [SECURITY.md](./SECURITY.md) for full threat model and analysis.

Key points:
- Admin key should be a Gnosis Safe multisig — the deployer should transfer `DEFAULT_ADMIN_ROLE` after initial setup
- Guardian should be a separate multisig from admin to provide independent emergency response
- The STAKE_LOCK_PERIOD (1 hour) protects against same-block flash loan attacks but not multi-block position building — consider lengthening for high-value deployments
- Allocation caps are a last-resort safety mechanism, not a substitute for good governance

---

## Design Tradeoffs

**Quadratic voting pools delegated stake before sqrt** — This means a delegatee with pooled stake gets more power than the sum of individual quadratic powers. This was intentional: it rewards users who actively consolidate voting rather than having passive stakes.

**Depth-1 delegation only** — Transitive delegation (A→B→C) creates complex loop-detection requirements and gas costs. Depth-1 keeps logic simple and auditable.

**Snapshot at proposal creation** — We snapshot `totalVotingPower` (based on `totalStaked`) at proposal creation rather than tracking per-account checkpoints (à la ERC20Votes). This is gas-efficient but means the quorum denominator is approximate when individual stakes change during voting.

**Status-quo bias on ties** — Tied votes (exact 50/50 after excluding abstain) resolve as Defeated. This prevents governance from approving changes without a clear majority.

**Treasury caps based on balance at execution time** — Caps are re-validated at execute time, not just at propose time. This prevents a scenario where the treasury grows between proposal creation and execution, allowing more ETH out than originally intended.

---

## Future Improvements

- **ERC20Votes checkpoint system** — Replace the current snapshot approximation with per-account checkpoints for fully accurate historical voting power queries
- **Token-based governance** — Issue a DAO token (ERC20Votes) instead of raw ETH staking to allow token transfers while preserving voting records
- **Transitive delegation with cycle detection** — Allow multi-hop delegation using a DAG structure with cycle detection
- **On-chain veto period** — Add a guardian-veto window after queuing where guardian can block execution without needing to cancel
- **Proposal categories** — Add metadata tags to proposals for off-chain indexing and filtering
- **Sub-DAOs** — Allow specialized committees with limited treasury allocations for faster operational decisions
- **Cross-chain governance** — Extend to L2s via message bridges for reduced gas costs on voting
- **Rage-quit mechanism** — Allow minority stakeholders to exit before a proposal executes if they voted Against
