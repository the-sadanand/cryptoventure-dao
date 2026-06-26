import { expect } from "chai";
import { ethers } from "hardhat";
import { parseEther } from "ethers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  deployDAO, DeployedContracts,
  ProposalType, VoteType, ProposalState,
  stakeAndWait, fundTreasury, createProposal, advanceTime,
  ONE_DAY, SEVEN_DAYS,
} from "./helpers";

describe("DAOTimelock", () => {
  let ctx: DeployedContracts;
  let admin: SignerWithAddress;
  let guardian: SignerWithAddress;
  let proposer: SignerWithAddress;
  let voter1: SignerWithAddress;
  let recipient: SignerWithAddress;

  beforeEach(async () => {
    [admin, guardian, proposer, voter1, recipient] = await ethers.getSigners();
    ctx = await deployDAO(admin, guardian);
    await fundTreasury(ctx.treasury, admin, "10");
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Queue → Execute Flow
  // ─────────────────────────────────────────────────────────────────────
  describe("Queue → Execute Flow", () => {
    it("should queue a succeeded proposal and set correct ETA", async () => {
      await stakeAndWait(ctx.governance, proposer, "0.2");
      await stakeAndWait(ctx.governance, voter1, "4");

      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Timelock queue"
      );
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");

      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);

      const queueTx = await ctx.governance.queue(proposalId);
      const queueReceipt = await queueTx.wait();

      await expect(queueTx).to.emit(ctx.governance, "ProposalQueued").withArgs(
        proposalId,
        (eta: bigint) => eta > 0n
      );

      const proposal = await ctx.governance.getProposal(proposalId);
      expect(proposal.state).to.equal(ProposalState.Queued);
      expect(proposal.executionETA).to.be.gt(0n);
    });

    it("should enforce delay for Operational proposals (1 day)", async () => {
      await stakeAndWait(ctx.governance, proposer, "0.2");
      await stakeAndWait(ctx.governance, voter1, "4");

      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "1-day timelock"
      );
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");

      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);
      await ctx.governance.queue(proposalId);

      // Half-way through timelock — cannot execute
      await advanceTime(ONE_DAY / 2);
      await expect(ctx.governance.execute(proposalId))
        .to.be.revertedWith("Gov: timelock not ready or expired");

      // Past timelock — can execute
      await advanceTime(ONE_DAY / 2 + 1);
      await expect(ctx.governance.execute(proposalId))
        .to.emit(ctx.governance, "ProposalExecuted");
    });

    it("should enforce 3-day delay for Experimental proposals", async () => {
      await stakeAndWait(ctx.governance, proposer, "0.2");
      await stakeAndWait(ctx.governance, voter1, "4");

      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Experimental, recipient.address, "1", "3-day timelock"
      );
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");

      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Experimental));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);
      await ctx.governance.queue(proposalId);

      await advanceTime(2 * ONE_DAY); // 2 days — not enough
      await expect(ctx.governance.execute(proposalId))
        .to.be.revertedWith("Gov: timelock not ready or expired");

      await advanceTime(ONE_DAY + 1); // +1 more = 3 days total
      await expect(ctx.governance.execute(proposalId))
        .to.emit(ctx.governance, "ProposalExecuted");
    });

    it("should enforce 7-day delay for HighConviction proposals", async () => {
      await stakeAndWait(ctx.governance, proposer, "0.2");
      await stakeAndWait(ctx.governance, voter1, "4");

      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.HighConviction, recipient.address, "4", "7-day timelock"
      );
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");

      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.HighConviction));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);
      await ctx.governance.queue(proposalId);

      await advanceTime(6 * ONE_DAY); // 6 days — not enough
      await expect(ctx.governance.execute(proposalId))
        .to.be.revertedWith("Gov: timelock not ready or expired");

      await advanceTime(ONE_DAY + 1); // +1 more = 7 days total
      await expect(ctx.governance.execute(proposalId))
        .to.emit(ctx.governance, "ProposalExecuted");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Expiration
  // ─────────────────────────────────────────────────────────────────────
  describe("Expiration", () => {
    it("should mark queued proposal as Expired after grace period (14 days)", async () => {
      await stakeAndWait(ctx.governance, proposer, "0.2");
      await stakeAndWait(ctx.governance, voter1, "4");

      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Expiry test"
      );
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");

      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);
      await ctx.governance.queue(proposalId);

      // Advance past timelock + grace period
      await advanceTime(ONE_DAY + 14 * ONE_DAY + 1);

      expect(await ctx.governance.state(proposalId)).to.equal(ProposalState.Expired);
    });

    it("should revert execution of expired proposal", async () => {
      await stakeAndWait(ctx.governance, proposer, "0.2");
      await stakeAndWait(ctx.governance, voter1, "4");

      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Expiry execute"
      );
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");

      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);
      await ctx.governance.queue(proposalId);
      await advanceTime(ONE_DAY + 14 * ONE_DAY + 1);

      await expect(ctx.governance.execute(proposalId))
        .to.be.revertedWith("Gov: proposal not queued");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Queue Failures
  // ─────────────────────────────────────────────────────────────────────
  describe("Queue Failures", () => {
    it("should revert queuing a non-succeeded proposal", async () => {
      await stakeAndWait(ctx.governance, proposer, "0.2");
      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Not succeeded"
      );

      await expect(ctx.governance.queue(proposalId))
        .to.be.revertedWith("Gov: proposal not succeeded");
    });

    it("should revert queuing a defeated proposal", async () => {
      await stakeAndWait(ctx.governance, proposer, "0.2");
      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Defeated"
      );

      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);

      await expect(ctx.governance.queue(proposalId))
        .to.be.revertedWith("Gov: proposal not succeeded");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Direct Timelock Tests
  // ─────────────────────────────────────────────────────────────────────
  describe("Direct DAOTimelock", () => {
    it("should revert direct queue call from non-executor", async () => {
      const opId = ethers.keccak256(ethers.toUtf8Bytes("test-op"));
      await expect(ctx.timelock.connect(voter1).queue(opId, ONE_DAY))
        .to.be.revertedWith("DAOTimelock: not executor");
    });

    it("should correctly report isQueued, isReady, isExpired", async () => {
      // Queue via governance (which has EXECUTOR_ROLE)
      await stakeAndWait(ctx.governance, proposer, "0.2");
      await stakeAndWait(ctx.governance, voter1, "4");

      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Direct TL"
      );
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");
      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);
      await ctx.governance.queue(proposalId);

      // Reconstruct operation ID (same as _operationId in governance)
      const proposal = await ctx.governance.getProposal(proposalId);
      const opId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "address", "uint256", "bytes32"],
          [proposal.id, proposal.recipient, proposal.amount, proposal.descriptionHash]
        )
      );

      expect(await ctx.timelock.isQueued(opId)).to.be.true;
      expect(await ctx.timelock.isReady(opId)).to.be.false;

      await advanceTime(ONE_DAY + 1);
      expect(await ctx.timelock.isReady(opId)).to.be.true;

      await advanceTime(14 * ONE_DAY + 1);
      expect(await ctx.timelock.isExpired(opId)).to.be.true;
    });
  });
});
