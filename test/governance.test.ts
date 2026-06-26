import { expect } from "chai";
import { ethers } from "hardhat";
import { parseEther } from "ethers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  deployDAO, DeployedContracts,
  ProposalType, VoteType, ProposalState,
  stakeAndWait, fundTreasury, createProposal, advanceTime,
  ONE_HOUR, ONE_DAY, THREE_DAYS, SEVEN_DAYS,
} from "./helpers";

describe("DAOGovernance — Core", () => {
  let ctx: DeployedContracts;
  let admin: SignerWithAddress;
  let guardian: SignerWithAddress;
  let proposer: SignerWithAddress;
  let voter1: SignerWithAddress;
  let voter2: SignerWithAddress;
  let recipient: SignerWithAddress;

  beforeEach(async () => {
    [admin, guardian, proposer, voter1, voter2, recipient] = await ethers.getSigners();
    ctx = await deployDAO(admin, guardian);
    await fundTreasury(ctx.treasury, admin, "10");
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Staking
  // ─────────────────────────────────────────────────────────────────────
  describe("Staking", () => {
    it("should accept ETH deposits and update stake", async () => {
      const amount = parseEther("1");
      await expect(ctx.governance.connect(proposer).deposit({ value: amount }))
        .to.emit(ctx.governance, "Deposit")
        .withArgs(proposer.address, amount, amount);

      expect(await ctx.governance.stakedBalance(proposer.address)).to.equal(amount);
    });

    it("should revert on zero deposit", async () => {
      await expect(ctx.governance.connect(proposer).deposit({ value: 0 }))
        .to.be.revertedWith("Gov: zero deposit");
    });

    it("should allow withdrawal after staking", async () => {
      const amount = parseEther("2");
      await ctx.governance.connect(voter1).deposit({ value: amount });
      const balBefore = await ethers.provider.getBalance(voter1.address);

      await ctx.governance.connect(voter1).withdraw(amount);

      const balAfter = await ethers.provider.getBalance(voter1.address);
      expect(balAfter).to.be.gt(balBefore); // net positive after gas
      expect(await ctx.governance.stakedBalance(voter1.address)).to.equal(0n);
    });

    it("should revert withdrawal above stake", async () => {
      await ctx.governance.connect(voter1).deposit({ value: parseEther("1") });
      await expect(ctx.governance.connect(voter1).withdraw(parseEther("2")))
        .to.be.revertedWith("Gov: insufficient stake");
    });

    it("should revert zero withdrawal", async () => {
      await ctx.governance.connect(voter1).deposit({ value: parseEther("1") });
      await expect(ctx.governance.connect(voter1).withdraw(0n))
        .to.be.revertedWith("Gov: zero withdrawal");
    });

    it("should update totalStaked correctly across multiple stakers", async () => {
      await ctx.governance.connect(voter1).deposit({ value: parseEther("1") });
      await ctx.governance.connect(voter2).deposit({ value: parseEther("3") });
      expect(await ctx.governance.totalStaked()).to.equal(parseEther("4"));

      await ctx.governance.connect(voter1).withdraw(parseEther("1"));
      expect(await ctx.governance.totalStaked()).to.equal(parseEther("3"));
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Proposal Creation
  // ─────────────────────────────────────────────────────────────────────
  describe("Proposal Creation", () => {
    beforeEach(async () => {
      await stakeAndWait(ctx.governance, proposer, "1");
    });

    it("should create an Operational proposal and emit event", async () => {
      const amount = parseEther("0.5"); // within 10% of 10 ETH
      await expect(
        ctx.governance.connect(proposer).propose(
          ProposalType.Operational,
          recipient.address,
          amount,
          "Operational test"
        )
      ).to.emit(ctx.governance, "ProposalCreated");

      const proposal = await ctx.governance.getProposal(1n);
      expect(proposal.id).to.equal(1n);
      expect(proposal.proposer).to.equal(proposer.address);
      expect(proposal.amount).to.equal(amount);
    });

    it("should create a HighConviction proposal", async () => {
      const amount = parseEther("5"); // within 60% of 10 ETH
      await ctx.governance.connect(proposer).propose(
        ProposalType.HighConviction,
        recipient.address,
        amount,
        "High conviction proposal"
      );
      const proposal = await ctx.governance.getProposal(1n);
      expect(proposal.proposalType).to.equal(ProposalType.HighConviction);
    });

    it("should revert if proposer has insufficient stake", async () => {
      const lowStaker = (await ethers.getSigners())[6];
      await ctx.governance.connect(lowStaker).deposit({ value: parseEther("0.05") });
      await advanceTime(ONE_HOUR + 1);

      await expect(
        ctx.governance.connect(lowStaker).propose(
          ProposalType.Operational,
          recipient.address,
          parseEther("0.1"),
          "Low stake proposal"
        )
      ).to.be.revertedWith("Gov: insufficient stake to propose");
    });

    it("should revert if stake lock period not elapsed", async () => {
      const freshStaker = (await ethers.getSigners())[6];
      await ctx.governance.connect(freshStaker).deposit({ value: parseEther("1") });
      // Do NOT advance time

      await expect(
        ctx.governance.connect(freshStaker).propose(
          ProposalType.Operational,
          recipient.address,
          parseEther("0.1"),
          "Flash loan attack"
        )
      ).to.be.revertedWith("Gov: stake lock period not elapsed");
    });

    it("should revert on zero recipient", async () => {
      await expect(
        ctx.governance.connect(proposer).propose(
          ProposalType.Operational,
          ethers.ZeroAddress,
          parseEther("0.1"),
          "Zero recipient"
        )
      ).to.be.revertedWith("Gov: zero recipient");
    });

    it("should revert on zero amount", async () => {
      await expect(
        ctx.governance.connect(proposer).propose(
          ProposalType.Operational,
          recipient.address,
          0n,
          "Zero amount"
        )
      ).to.be.revertedWith("Gov: zero amount");
    });

    it("should revert if amount exceeds treasury allocation cap", async () => {
      // Operational cap is 10% of 10 ETH = 1 ETH; request 2 ETH
      await expect(
        ctx.governance.connect(proposer).propose(
          ProposalType.Operational,
          recipient.address,
          parseEther("2"),
          "Over cap"
        )
      ).to.be.revertedWith("Gov: amount exceeds treasury allocation cap");
    });

    it("should prevent one proposer from having two active proposals", async () => {
      await ctx.governance.connect(proposer).propose(
        ProposalType.Operational,
        recipient.address,
        parseEther("0.1"),
        "First proposal"
      );

      await expect(
        ctx.governance.connect(proposer).propose(
          ProposalType.Operational,
          recipient.address,
          parseEther("0.1"),
          "Second proposal"
        )
      ).to.be.revertedWith("Gov: proposer has active proposal");
    });

    it("should reject empty description", async () => {
      await expect(
        ctx.governance.connect(proposer).propose(
          ProposalType.Operational,
          recipient.address,
          parseEther("0.1"),
          ""
        )
      ).to.be.revertedWith("Gov: empty description");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Proposal State Machine
  // ─────────────────────────────────────────────────────────────────────
  describe("Proposal State", () => {
    let proposalId: bigint;

    beforeEach(async () => {
      await stakeAndWait(ctx.governance, proposer, "1");
      await stakeAndWait(ctx.governance, voter1, "4");
      await stakeAndWait(ctx.governance, voter2, "4");

      proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "State test"
      );
    });

    it("should start in Active state", async () => {
      expect(await ctx.governance.state(proposalId)).to.equal(ProposalState.Active);
    });

    it("should transition to Succeeded after votes pass", async () => {
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");
      await ctx.governance.connect(voter2).castVote(proposalId, VoteType.For, "");

      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);

      expect(await ctx.governance.state(proposalId)).to.equal(ProposalState.Succeeded);
    });

    it("should transition to Defeated if quorum not met", async () => {
      // Nobody votes
      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);

      expect(await ctx.governance.state(proposalId)).to.equal(ProposalState.Defeated);
    });

    it("should transition to Defeated if approval threshold not met", async () => {
      // voter1 votes against (has more power than voter2 who votes for)
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.Against, "");
      await ctx.governance.connect(voter2).castVote(proposalId, VoteType.For, "");

      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);

      expect(await ctx.governance.state(proposalId)).to.equal(ProposalState.Defeated);
    });

    it("should revert state query for unknown proposal", async () => {
      await expect(ctx.governance.state(999n))
        .to.be.revertedWith("Gov: unknown proposal");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Execute
  // ─────────────────────────────────────────────────────────────────────
  describe("Execute", () => {
    it("should execute a queued proposal and transfer ETH", async () => {
      await stakeAndWait(ctx.governance, proposer, "1");
      await stakeAndWait(ctx.governance, voter1,   "4");
      await stakeAndWait(ctx.governance, voter2,   "4");

      const amount = parseEther("0.5");
      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Execute test"
      );

      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");
      await ctx.governance.connect(voter2).castVote(proposalId, VoteType.For, "");

      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);

      await ctx.governance.queue(proposalId);
      await advanceTime(Number(cfg.timelockSeconds) + 1);

      const recipientBalBefore = await ethers.provider.getBalance(recipient.address);

      await expect(ctx.governance.execute(proposalId))
        .to.emit(ctx.governance, "ProposalExecuted")
        .withArgs(proposalId);

      const recipientBalAfter = await ethers.provider.getBalance(recipient.address);
      expect(recipientBalAfter - recipientBalBefore).to.equal(amount);
      expect(await ctx.governance.state(proposalId)).to.equal(ProposalState.Executed);
    });

    it("should revert execution before timelock elapsed", async () => {
      await stakeAndWait(ctx.governance, proposer, "1");
      await stakeAndWait(ctx.governance, voter1,   "4");

      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Early execute"
      );
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");
      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);
      await ctx.governance.queue(proposalId);

      // Do NOT advance past timelock
      await expect(ctx.governance.execute(proposalId))
        .to.be.revertedWith("Gov: timelock not ready or expired");
    });

    it("should revert double execution", async () => {
      await stakeAndWait(ctx.governance, proposer, "1");
      await stakeAndWait(ctx.governance, voter1,   "4");

      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Double execute"
      );
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");
      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);
      await ctx.governance.queue(proposalId);
      await advanceTime(Number(cfg.timelockSeconds) + 1);
      await ctx.governance.execute(proposalId);

      await expect(ctx.governance.execute(proposalId))
        .to.be.revertedWith("Gov: proposal not queued");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Cancel
  // ─────────────────────────────────────────────────────────────────────
  describe("Cancel", () => {
    it("should allow proposer to cancel an active proposal", async () => {
      await stakeAndWait(ctx.governance, proposer, "1");
      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "To cancel"
      );

      await expect(ctx.governance.connect(proposer).cancel(proposalId))
        .to.emit(ctx.governance, "ProposalCancelled")
        .withArgs(proposalId, proposer.address);

      expect(await ctx.governance.state(proposalId)).to.equal(ProposalState.Cancelled);
    });

    it("should allow guardian to cancel any active proposal", async () => {
      await stakeAndWait(ctx.governance, proposer, "1");
      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Guardian cancel"
      );

      await expect(ctx.governance.connect(guardian).cancel(proposalId))
        .to.emit(ctx.governance, "ProposalCancelled");
    });

    it("should revert cancel from unauthorized address", async () => {
      await stakeAndWait(ctx.governance, proposer, "1");
      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Unauthorized cancel"
      );

      await expect(ctx.governance.connect(voter1).cancel(proposalId))
        .to.be.revertedWith("Gov: not proposer or guardian");
    });

    it("should revert cancel of executed proposal", async () => {
      await stakeAndWait(ctx.governance, proposer, "1");
      await stakeAndWait(ctx.governance, voter1,   "4");

      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Cancel executed"
      );
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");
      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);
      await ctx.governance.queue(proposalId);
      await advanceTime(Number(cfg.timelockSeconds) + 1);
      await ctx.governance.execute(proposalId);

      await expect(ctx.governance.connect(guardian).cancel(proposalId))
        .to.be.revertedWith("Gov: cannot cancel in current state");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Emergency Pause
  // ─────────────────────────────────────────────────────────────────────
  describe("Emergency Pause", () => {
    it("should pause and unpause by guardian", async () => {
      await expect(ctx.governance.connect(guardian).pause())
        .to.emit(ctx.governance, "EmergencyPause");

      await stakeAndWait(ctx.governance, proposer, "1").catch(() => {}); // may fail
      await expect(
        ctx.governance.connect(proposer).deposit({ value: parseEther("1") })
      ).to.be.reverted;

      await expect(ctx.governance.connect(guardian).unpause())
        .to.emit(ctx.governance, "EmergencyUnpause");
    });

    it("should revert pause from non-guardian", async () => {
      await expect(ctx.governance.connect(voter1).pause())
        .to.be.revertedWith("Gov: not guardian");
    });
  });
});
