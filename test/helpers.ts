import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  DAOAccessControl,
  VotingPowerCalculator,
  Treasury,
  DAOTimelock,
  DAOGovernance,
} from "../typechain-types";
import { parseEther } from "ethers";

// ─────────────────────────────────────────────────────────────────────
//  ProposalType enum mirrors GovernanceTypes.ProposalType
// ─────────────────────────────────────────────────────────────────────
export const ProposalType = {
  HighConviction: 0n,
  Experimental:   1n,
  Operational:    2n,
} as const;

export const VoteType = {
  Against: 0n,
  For:     1n,
  Abstain: 2n,
} as const;

export const ProposalState = {
  Pending:   0n,
  Active:    1n,
  Defeated:  2n,
  Succeeded: 3n,
  Queued:    4n,
  Executed:  5n,
  Cancelled: 6n,
  Expired:   7n,
} as const;

// ─────────────────────────────────────────────────────────────────────
//  Deployment fixture
// ─────────────────────────────────────────────────────────────────────
export interface DeployedContracts {
  accessControl: DAOAccessControl;
  calculator:    VotingPowerCalculator;
  treasury:      Treasury;
  timelock:      DAOTimelock;
  governance:    DAOGovernance;
}

export async function deployDAO(
  admin:    SignerWithAddress,
  guardian: SignerWithAddress
): Promise<DeployedContracts> {
  const AccessControlFactory = await ethers.getContractFactory("DAOAccessControl");
  const accessControl = (await AccessControlFactory.deploy(
    admin.address,
    guardian.address
  )) as unknown as DAOAccessControl;
  await accessControl.waitForDeployment();

  const CalculatorFactory = await ethers.getContractFactory("VotingPowerCalculator");
  const calculator = (await CalculatorFactory.deploy()) as unknown as VotingPowerCalculator;
  await calculator.waitForDeployment();

  const TreasuryFactory = await ethers.getContractFactory("Treasury");
  const treasury = (await TreasuryFactory.deploy(
    await accessControl.getAddress()
  )) as unknown as Treasury;
  await treasury.waitForDeployment();

  const TimelockFactory = await ethers.getContractFactory("DAOTimelock");
  const timelock = (await TimelockFactory.deploy(
    await accessControl.getAddress()
  )) as unknown as DAOTimelock;
  await timelock.waitForDeployment();

  const GovernanceFactory = await ethers.getContractFactory("DAOGovernance");
  const governance = (await GovernanceFactory.deploy(
    await accessControl.getAddress(),
    await calculator.getAddress(),
    await treasury.getAddress(),
    await timelock.getAddress()
  )) as unknown as DAOGovernance;
  await governance.waitForDeployment();

  // Wire roles
  const EXECUTOR_ROLE  = await accessControl.EXECUTOR_ROLE();
  const TREASURER_ROLE = await accessControl.TREASURER_ROLE();
  const govAddr        = await governance.getAddress();

  await accessControl.connect(admin).grantRole(EXECUTOR_ROLE,  govAddr);
  await accessControl.connect(admin).grantRole(TREASURER_ROLE, govAddr);

  return { accessControl, calculator, treasury, timelock, governance };
}

// ─────────────────────────────────────────────────────────────────────
//  Common helpers
// ─────────────────────────────────────────────────────────────────────

export const ONE_HOUR  = 3_600;
export const ONE_DAY   = 86_400;
export const THREE_DAYS = 3 * ONE_DAY;
export const SEVEN_DAYS = 7 * ONE_DAY;

/**
 * Advance block time by `seconds`
 */
export async function advanceTime(seconds: number): Promise<void> {
  await time.increase(seconds);
}

/**
 * Fund treasury with `ethAmount` ETH from `funder`
 */
export async function fundTreasury(
  treasury: Treasury,
  funder:   SignerWithAddress,
  ethAmount: string
): Promise<void> {
  await funder.sendTransaction({
    to:    await treasury.getAddress(),
    value: parseEther(ethAmount),
  });
}

/**
 * Stake `ethAmount` ETH for `staker`, then advance past stake lock period
 */
export async function stakeAndWait(
  governance: DAOGovernance,
  staker:     SignerWithAddress,
  ethAmount:  string
): Promise<void> {
  await governance.connect(staker).deposit({ value: parseEther(ethAmount) });
  await advanceTime(ONE_HOUR + 1); // past STAKE_LOCK_PERIOD
}

/**
 * Create a proposal and return its ID (BigInt)
 */
export async function createProposal(
  governance:   DAOGovernance,
  proposer:     SignerWithAddress,
  proposalType: bigint,
  recipient:    string,
  amount:       string,
  description:  string
): Promise<bigint> {
  const tx = await governance.connect(proposer).propose(
    Number(proposalType),
    recipient,
    parseEther(amount),
    description
  );
  const receipt = await tx.wait();
  const log = receipt?.logs.find((l: any) => {
    try {
      const parsed = governance.interface.parseLog({ topics: l.topics as string[], data: l.data });
      return parsed?.name === "ProposalCreated";
    } catch { return false; }
  });
  if (!log) throw new Error("ProposalCreated event not found");
  const parsed = governance.interface.parseLog({ topics: log.topics as string[], data: log.data });
  return parsed!.args[0] as bigint;
}

/**
 * Full proposal lifecycle helper: create → vote → queue → execute
 */
export async function fullLifecycle(
  governance:   DAOGovernance,
  proposer:     SignerWithAddress,
  voters:       SignerWithAddress[],
  proposalType: bigint,
  recipient:    string,
  amount:       string
): Promise<bigint> {
  const proposalId = await createProposal(
    governance, proposer, proposalType, recipient, amount, "Full lifecycle test"
  );

  // All voters vote FOR
  for (const v of voters) {
    await governance.connect(v).castVote(proposalId, Number(VoteType.For), "");
  }

  // Advance past voting period
  const cfg = await governance.getTypeConfig(Number(proposalType));
  await advanceTime(Number(cfg.votingPeriodSeconds) + 1);

  // Queue
  await governance.queue(proposalId);

  // Advance past timelock
  await advanceTime(Number(cfg.timelockSeconds) + 1);

  // Execute
  await governance.execute(proposalId);

  return proposalId;
}
