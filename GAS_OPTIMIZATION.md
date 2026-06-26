# Gas Optimization Report — CryptoVentures DAO

## Summary

| Operation | Estimated Gas | Notes |
|---|---|---|
| `deposit()` | ~45,000 | Two SSTORE (stake + totalStaked), one timestamp SSTORE |
| `withdraw()` | ~35,000 | Two SSTORE decrements + ETH transfer |
| `delegate()` | ~50,000 | Three SSTORE (delegate map, two delegatedStake entries) |
| `propose()` | ~180,000 | Full Proposal struct write (~10 storage slots) + event |
| `castVote()` | ~65,000 | VoteReceipt SSTORE + forVotes/againstVotes increment + event |
| `queue()` | ~55,000 | Timelock SSTORE + proposal state update |
| `execute()` | ~80,000 + recipient cost | State update + timelock clear + ETH transfer |
| `cancel()` | ~30,000 | Two SSTORE (cancelled, state) |

All estimates assume a warm storage slot (SSTORE 5,000 for dirty → clean) and exclude base transaction cost (21,000 gas).

---

## 1. Storage Packing

### GovernanceTypes.Proposal

The `Proposal` struct is carefully ordered to pack fields into as few 32-byte EVM storage slots as possible.

```solidity
struct Proposal {
    uint256 id;                       // slot 0
    address proposer;                 // slot 1 (20 bytes)
    ProposalType proposalType;        // slot 1 continued (1 byte)
    ProposalState state;              // slot 1 continued (1 byte)
    uint64 voteStart;                 // slot 1 continued (8 bytes) — packed!
    uint64 voteEnd;                   // slot 2 (8 bytes)
    uint64 queuedAt;                  // slot 2 continued (8 bytes)
    uint64 executionETA;              // slot 2 continued (8 bytes)
    uint256 forVotes;                 // slot 3
    uint256 againstVotes;             // slot 4
    uint256 abstainVotes;             // slot 5
    uint256 totalVotingPowerSnapshot; // slot 6
    address payable recipient;        // slot 7 (20 bytes)
    uint256 amount;                   // slot 8
    string description;               // slot 9+ (dynamic)
    bytes32 descriptionHash;          // next slot
    bool executed;                    // packed with bool cancelled
    bool cancelled;
}
```

**Savings:** The four `uint64` timestamp fields (voteStart, voteEnd, queuedAt, executionETA) and the enum/state/address/booleans are packed together, saving approximately 4–5 storage slots vs. using `uint256` for each field individually. At 20,000 gas per new SSTORE write, this saves ~80,000–100,000 gas per proposal creation.

### ProposalTypeConfig

```solidity
struct ProposalTypeConfig {
    uint16 approvalBPS;          // 2 bytes
    uint16 quorumBPS;            // 2 bytes
    uint32 timelockSeconds;      // 4 bytes
    uint16 maxTreasuryAllocBPS;  // 2 bytes
    uint32 votingPeriodSeconds;  // 4 bytes
}  // Total: 14 bytes → fits in one 32-byte slot
```

All five config fields are packed into a single storage slot per proposal type. The three configs occupy 3 slots total.

---

## 2. Mapping Design

### Why mappings over arrays

All proposal data is stored in `mapping(uint256 => Proposal)` rather than an array. Benefits:
- O(1) access by proposal ID (no iteration needed)
- No array length SSTORE on each new proposal
- No risk of array-length overflow
- Easier to query by ID from front-ends

### Nested mapping for vote receipts

```solidity
mapping(uint256 => mapping(address => VoteReceipt)) private _receipts;
```

Nested mappings are more gas-efficient than a flat `mapping(bytes32 => VoteReceipt)` using a composite key because:
- The EVM computes slot addresses by hashing, so the cost is equivalent
- Type safety is improved
- Solidity doesn't need to pack/unpack composite keys in client code

### Separate delegation maps

```solidity
mapping(address => address) private _delegates;       // O(1) lookup of who A delegates to
mapping(address => uint256) private _delegatedStake;  // O(1) total stake delegated to B
```

Splitting into two maps (delegatee lookup + aggregated stake) avoids iterating over all delegators when computing voting power. This reduces `getVotingPower()` from O(n delegators) to O(1).

---

## 3. Event Design

Events are structured to balance indexing richness with calldata cost.

### Indexed fields (3-per-event maximum)

```solidity
event ProposalCreated(
    uint256 indexed proposalId,    // cheaply filterable by ID
    address indexed proposer,      // cheaply filterable by creator
    GovernanceTypes.ProposalType proposalType,  // non-indexed (enum, low cardinality)
    address recipient,
    uint256 amount,
    uint64 voteStart,
    uint64 voteEnd,
    string description             // non-indexed (large, stored in calldata)
);

event VoteCast(
    address indexed voter,
    uint256 indexed proposalId,
    GovernanceTypes.VoteType support,
    uint256 votes,
    string reason                  // non-indexed (optional, large)
);
```

**Calldata savings:** Using `uint64` instead of `uint256` for timestamps in events halves the calldata cost for those fields (from 32 to 8 bytes after ABI encoding).

### Reason strings in VoteCast

The `reason` parameter in `castVote()` is `calldata` (not `memory`), saving the cost of copying it into memory. Empty string is perfectly valid and costs only the minimal ABI overhead.

---

## 4. Calculation Optimizations

### Babylonian Square Root

The `_sqrt()` function uses the Babylonian (Newton's) method:

```solidity
function _sqrt(uint256 x) internal pure returns (uint256) {
    if (x == 0) return 0;
    if (x <= 3) return 1;
    uint256 z = x;
    uint256 y = (x + 1) >> 1;   // bit-shift instead of division
    while (y < z) {
        z = y;
        y = (x / y + y) >> 1;
    }
    return z;
}
```

**Gas profile:** Roughly 300–500 gas for inputs in the 10^9–10^12 range (typical after normalisation). Bit-shifting (`>> 1`) is cheaper than explicit division by 2 (saves ~3 gas per iteration).

**Early exits:** The `if (x == 0) return 0` and `if (x <= 3) return 1` short-circuits save the loop entirely for edge cases.

### BPS_DENOMINATOR as a constant

```solidity
uint256 private constant BPS_DENOMINATOR = 10_000;
```

Constants are inlined by the compiler at compile time, costing zero gas for storage lookup. Using a named constant also prevents magic number bugs.

### Immutable addresses

All dependency contract addresses (accessControl, calculator, treasury, timelock) are declared `immutable`. Immutables are stored in contract bytecode and read at ~3 gas (vs. ~200 gas for a cold storage SLOAD).

```solidity
DAOAccessControl  public immutable accessControl;
VotingPowerCalculator public immutable calculator;
ITreasury         public immutable treasury;
DAOTimelock       public immutable timelock;
```

---

## 5. Function Visibility

- All internal helpers (`_sqrt`, `_operationId`) are `private` — prevents virtual dispatch overhead and disallows external calls.
- View functions (`state()`, `getReceipt()`, `getProposal()`) are `view` — clients can call them for free off-chain.
- `getTypeConfig()` returns the struct from storage as `memory` to avoid multiple SLOAD calls in client code.

---

## 6. String Storage

The `description` field in `Proposal` is an unbounded `string`. For long descriptions, this is the most expensive part of `propose()`. Alternatives considered:

| Approach | Gas cost | Trade-off |
|---|---|---|
| Store full string on-chain (current) | High | Full data available on-chain |
| Store only keccak256 hash | Very low | Description must be fetched from events or IPFS |
| Store first 256 bytes on-chain | Medium | Partial data available without external lookup |

The `descriptionHash` field (`bytes32`) is stored alongside the full string, allowing efficient comparison and use as the timelock operation ID input without re-hashing the full string.

**Recommendation for production:** Store only `descriptionHash` on-chain and emit the full description in the `ProposalCreated` event. Front-ends retrieve it from event logs or IPFS.

---

## 7. Optimizer Settings

```typescript
solidity: {
  version: "0.8.20",
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,   // optimise for ~200 calls per function over contract lifetime
    },
  },
},
```

`runs: 200` is the standard production setting. It balances deployment cost (fewer runs = smaller bytecode) against execution cost (more runs = cheaper repeated calls). For a DAO where proposals are created infrequently but votes may be cast many times, `runs: 500–1000` could reduce per-vote gas at the cost of higher deployment cost.

---

## 8. Potential Further Optimisations

### Replace string description with IPFS hash

Store a `bytes32` IPFS CID hash instead of the full description string. Saves ~20,000–200,000+ gas on `propose()` depending on description length.

### Use EIP-1967 proxy pattern

Deploying behind a proxy (UUPS or Transparent) allows upgrades without re-deploying the entire system, preserving state. Also reduces initial deployment cost by ~30% if storage is shared.

### Bitmap for vote tracking

Replace `VoteReceipt` (3 storage slots per voter per proposal) with a packed bitmap:

```solidity
mapping(uint256 => mapping(uint256 => uint256)) private _voteBitmaps;
// proposalId → (voterAddress / 256) → bitmap of voted flags
```

Saves 2 SSTORE slots per voter per proposal at the cost of more complex bitmap arithmetic (~5,000–10,000 gas saved per castVote).

### Batch vote emission

In high-throughput scenarios, aggregate multiple small votes and emit a batch event rather than one event per vote. Not applicable to this single-vote-per-address design but useful for delegation trees.
