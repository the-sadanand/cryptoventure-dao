# DAO Governance Assignment

This branch adapts the existing CryptoVentures DAO repository into a focused OpenZeppelin Governor + Timelock + upgradeable Treasury implementation.

## Architecture

```text
GovernanceToken (ERC20Votes)
        |
        v
   MyGovernor
        |
        v
TimelockController
        |
        +------> Treasury Proxy (UUPS)
                       |
                       +------> Treasury V1
                       |
                       +------> Treasury V2
```

The governance path is:

```text
propose -> vote -> Succeeded -> queue -> timelock delay -> execute
```

The treasury upgrade path is also governance-controlled:

```text
proposal -> vote -> queue -> delay -> execute upgradeToAndCall -> TreasuryV2
```

OpenZeppelin documents `GovernorTimelockControl` as the Governor extension that connects a Governor to `TimelockController`, adding a queue/delay before execution. The Timelock should hold the permissions/assets controlled by governance. citeturn1search0turn1search1

## Assignment Files

| File | Purpose |
|---|---|
| `contracts/task/GovernanceToken.sol` | ERC20Votes governance token |
| `contracts/task/MyGovernor.sol` | OpenZeppelin Governor + quorum + Timelock integration |
| `contracts/task/Treasury.sol` | UUPS upgradeable ETH treasury V1 |
| `contracts/task/TreasuryV2.sol` | Treasury V2 with new functionality |
| `scripts/task-deploy.ts` | Local deployment and role configuration |
| `test/DAOAssignment.test.ts` | Full proposal lifecycle + upgrade tests |
| `Dockerfile` | Containerized Hardhat test environment |
| `docker-compose.yml` | Reproducible test command |

## Setup

```bash
npm install
npm run compile
npm run test:assignment
```

## Run locally

Terminal 1:

```bash
npm run node
```

Terminal 2:

```bash
npm run deploy:assignment
```

## Docker

```bash
docker compose up --build
```

## Design Notes

- `GovernanceToken` uses OpenZeppelin `ERC20Votes`, so voters need delegated voting power for checkpoints.
- `MyGovernor` uses `GovernorCountingSimple`, `GovernorVotes`, `GovernorVotesQuorumFraction`, and `GovernorTimelockControl`.
- The test deployment gives the Governor proposer/canceller permissions on the Timelock and removes the deployer's proposer/canceller/admin permissions after setup.
- Treasury V1 is deployed behind an ERC1967 proxy and uses UUPS authorization through the Timelock owner.
- Treasury V2 keeps the existing storage layout and adds `sweep()` plus `version() == 2`.
- The upgrade test verifies that the proxy address and ETH balance remain unchanged after the governance-approved implementation upgrade.

## Existing Repository Base

The implementation is based on the existing `the-sadanand/cryptoventure-dao` project. Its original project already contains Solidity contracts for governance, access control, timelock, treasury, interfaces, Hardhat configuration, tests, and TypeScript tooling. The assignment implementation is isolated under `contracts/task/` so the original project code remains available.

## References

- OpenZeppelin Governor and Timelock documentation: https://docs.openzeppelin.com/contracts/5.x/governance
- OpenZeppelin upgradeable contracts documentation: https://docs.openzeppelin.com/contracts/5.x/upgradeable
- OpenZeppelin UUPS documentation: https://docs.openzeppelin.com/contracts/5.x/api/proxy
