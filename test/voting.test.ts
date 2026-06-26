import { expect } from "chai";
import { ethers } from "hardhat";
import { parseEther } from "ethers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  deployDAO, DeployedContracts,
  ProposalType, VoteType, ProposalState,
  stakeAndWait, fundTreasury, createProposal, advanceTime,
  ONE_HOUR,
} from "./helpers";

describe("DAOGovernance — Voting", () => {
  let ctx: DeployedContracts;
  let admin: SignerWithAddress;
  let guardian: SignerWithAddress;
  let proposer: SignerWithAddress;
  let voter1: SignerWithAddress;
  let voter2: SignerWithAddress;
  let voter3: SignerWithAddress;
  let recipient: SignerWithAddress;
  let proposalId: bigint;

  beforeEach(async () => {
    [admin, guardian, proposer, voter1, voter2, voter3, recipient] = await ethers.getSigners();
    ctx = await deployDAO(admin, guardian);
    await fundTreasury(ctx.treasury, admin, "10");

    // Stake so that all three voters have power
    await stakeAndWait(ctx.governance, proposer, "0.2");
    await stakeAndWait(ctx.governance, voter1, "1");
    await stakeAndWait(ctx.governance, voter2, "4");
    await stakeAndWait(ctx.governance, voter3, "9");

    proposalId = await createProposal(
      ctx.governance, proposer,
      ProposalType.Operational, recipient.address, "0.5", "Voting tests"
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Happy Paths
  // ─────────────────────────────────────────────────────────────────────
  describe("Happy Paths", () => {
    it("should allow voter to cast For vote", async () => {
      await expect(
        ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "I support this")
      )
        .to.emit(ctx.governance, "VoteCast")
        .withArgs(voter1.address, proposalId, VoteType.For, (votes: bigint) => votes > 0n, "I support this");

      const receipt = await ctx.governance.getReceipt(proposalId, voter1.address);
      expect(receipt.hasVoted).to.be.true;
      expect(receipt.support).to.equal(VoteType.For);
      expect(receipt.votes).to.be.gt(0n);
    });

    it("should allow Against vote", async () => {
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.Against, "No");
      const receipt = await ctx.governance.getReceipt(proposalId, voter1.address);
      expect(receipt.support).to.equal(VoteType.Against);
    });

    it("should allow Abstain vote", async () => {
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.Abstain, "Neutral");
      const receipt = await ctx.governance.getReceipt(proposalId, voter1.address);
      expect(receipt.support).to.equal(VoteType.Abstain);
    });

    it("should count votes correctly across different vote types", async () => {
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For,     "");
      await ctx.governance.connect(voter2).castVote(proposalId, VoteType.Against, "");
      await ctx.governance.connect(voter3).castVote(proposalId, VoteType.Abstain, "");

      const proposal = await ctx.governance.getProposal(proposalId);
      expect(proposal.forVotes).to.be.gt(0n);
      expect(proposal.againstVotes).to.be.gt(0n);
      expect(proposal.abstainVotes).to.be.gt(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Quadratic Voting Verification
  // ─────────────────────────────────────────────────────────────────────
  describe("Quadratic Voting", () => {
    it("should assign quadratic power: 4 ETH gives 2× power of 1 ETH", async () => {
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");
      await ctx.governance.connect(voter2).castVote(proposalId, VoteType.For, "");

      const receipt1 = await ctx.governance.getReceipt(proposalId, voter1.address);
      const receipt2 = await ctx.governance.getReceipt(proposalId, voter2.address);

      // voter1 = 1 ETH → sqrt(1e9) ≈ 31622; voter2 = 4 ETH → sqrt(4e9) ≈ 63245
      const ratio = receipt2.votes / receipt1.votes;
      expect(ratio).to.be.gte(1n).and.lte(3n); // roughly 2×, not 4×
    });

    it("should assign quadratic power: 9 ETH gives 3× power of 1 ETH", async () => {
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");
      await ctx.governance.connect(voter3).castVote(proposalId, VoteType.For, "");

      const receipt1 = await ctx.governance.getReceipt(proposalId, voter1.address);
      const receipt3 = await ctx.governance.getReceipt(proposalId, voter3.address);

      const ratio = receipt3.votes / receipt1.votes;
      expect(ratio).to.be.gte(2n).and.lte(4n); // roughly 3×, not 9×
    });

    it("should return zero voting power for account with no stake", async () => {
      const noStake = (await ethers.getSigners())[8];
      expect(await ctx.governance.getVotingPower(noStake.address)).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Failure Paths
  // ─────────────────────────────────────────────────────────────────────
  describe("Failure Paths", () => {
    it("should revert double voting", async () => {
      await ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "");
      await expect(
        ctx.governance.connect(voter1).castVote(proposalId, VoteType.Against, "")
      ).to.be.revertedWith("Gov: already voted");
    });

    it("should revert voting on non-existent proposal", async () => {
      await expect(
        ctx.governance.connect(voter1).castVote(999n, VoteType.For, "")
      ).to.be.revertedWith("Gov: proposal does not exist");
    });

    it("should revert voting after voting period ends", async () => {
      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);

      await expect(
        ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "")
      ).to.be.revertedWith("Gov: proposal not active");
    });

    it("should revert voting on cancelled proposal", async () => {
      await ctx.governance.connect(proposer).cancel(proposalId);
      await expect(
        ctx.governance.connect(voter1).castVote(proposalId, VoteType.For, "")
      ).to.be.revertedWith("Gov: proposal not active");
    });

    it("should revert voting by account with zero voting power", async () => {
      const noStake = (await ethers.getSigners())[8];
      await expect(
        ctx.governance.connect(noStake).castVote(proposalId, VoteType.For, "")
      ).to.be.reverted;
    });

    it("should revert if voter deposited AFTER vote start (flash-loan protection)", async () => {
      // A fresh staker deposits AFTER the proposal is created (voteStart is proposal creation)
      const lateSigner = (await ethers.getSigners())[8];
      // Deposit happens AFTER proposal creation in this block
      await ctx.governance.connect(lateSigner).deposit({ value: parseEther("5") });

      await expect(
        ctx.governance.connect(lateSigner).castVote(proposalId, VoteType.For, "")
      ).to.be.revertedWith("Gov: stake deposited after vote start");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Tie Handling
  // ─────────────────────────────────────────────────────────────────────
  describe("Tie Handling", () => {
    it("should treat a tie as Defeated (status quo bias)", async () => {
      // voter1 and voter2 have same stake for a symmetric tie test
      // Deploy fresh with equal stakes
      const [a, g, p, v1, v2, rec] = await ethers.getSigners();
      const fresh = await deployDAO(a, g);
      await fundTreasury(fresh.treasury, a, "10");

      // Equal stakes
      await fresh.governance.connect(v1).deposit({ value: parseEther("4") });
      await fresh.governance.connect(v2).deposit({ value: parseEther("4") });
      await advanceTime(ONE_HOUR + 1);

      const pid = await createProposal(
        fresh.governance, v1,
        ProposalType.Operational, rec.address, "0.5", "Tie test"
      );

      await fresh.governance.connect(v1).castVote(pid, VoteType.For,     "");
      await fresh.governance.connect(v2).castVote(pid, VoteType.Against, "");

      const cfg = await fresh.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);

      expect(await fresh.governance.state(pid)).to.equal(ProposalState.Defeated);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Zero-Vote Proposals
  // ─────────────────────────────────────────────────────────────────────
  describe("Zero Vote Edge Case", () => {
    it("should mark a proposal as Defeated when no votes are cast", async () => {
      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);

      expect(await ctx.governance.state(proposalId)).to.equal(ProposalState.Defeated);
    });
  });
});
