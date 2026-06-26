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

describe("DAOGovernance — Delegation", () => {
  let ctx: DeployedContracts;
  let admin: SignerWithAddress;
  let guardian: SignerWithAddress;
  let delegator: SignerWithAddress;
  let delegatee: SignerWithAddress;
  let proposer: SignerWithAddress;
  let recipient: SignerWithAddress;

  beforeEach(async () => {
    [admin, guardian, delegator, delegatee, proposer, recipient] = await ethers.getSigners();
    ctx = await deployDAO(admin, guardian);
    await fundTreasury(ctx.treasury, admin, "10");
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Happy Paths
  // ─────────────────────────────────────────────────────────────────────
  describe("Happy Paths", () => {
    it("should allow delegation and update delegatedStake", async () => {
      await ctx.governance.connect(delegator).deposit({ value: parseEther("4") });
      await ctx.governance.connect(delegatee).deposit({ value: parseEther("1") });

      await expect(ctx.governance.connect(delegator).delegate(delegatee.address))
        .to.emit(ctx.governance, "DelegationChanged")
        .withArgs(delegator.address, ethers.ZeroAddress, delegatee.address);

      expect(await ctx.governance.delegates(delegator.address)).to.equal(delegatee.address);
      expect(await ctx.governance.delegatedStakeTo(delegatee.address)).to.equal(parseEther("4"));
    });

    it("should increase delegatee voting power with delegated stake", async () => {
      await ctx.governance.connect(delegatee).deposit({ value: parseEther("1") });
      const powerBefore = await ctx.governance.getVotingPower(delegatee.address);

      await ctx.governance.connect(delegator).deposit({ value: parseEther("9") });
      await ctx.governance.connect(delegator).delegate(delegatee.address);

      const powerAfter = await ctx.governance.getVotingPower(delegatee.address);
      expect(powerAfter).to.be.gt(powerBefore);
    });

    it("should allow undelegation and remove delegated stake", async () => {
      await ctx.governance.connect(delegator).deposit({ value: parseEther("4") });
      await ctx.governance.connect(delegatee).deposit({ value: parseEther("1") });
      await ctx.governance.connect(delegator).delegate(delegatee.address);

      await expect(ctx.governance.connect(delegator).undelegate())
        .to.emit(ctx.governance, "DelegationChanged")
        .withArgs(delegator.address, delegatee.address, ethers.ZeroAddress);

      expect(await ctx.governance.delegates(delegator.address)).to.equal(ethers.ZeroAddress);
      expect(await ctx.governance.delegatedStakeTo(delegatee.address)).to.equal(0n);
    });

    it("should allow re-delegation to a different address", async () => {
      const [,,,,,, newDelegatee] = await ethers.getSigners();
      await ctx.governance.connect(delegator).deposit({ value: parseEther("4") });
      await ctx.governance.connect(delegatee).deposit({ value: parseEther("1") });
      await ctx.governance.connect(newDelegatee).deposit({ value: parseEther("1") });

      await ctx.governance.connect(delegator).delegate(delegatee.address);
      await ctx.governance.connect(delegator).delegate(newDelegatee.address);

      expect(await ctx.governance.delegates(delegator.address)).to.equal(newDelegatee.address);
      expect(await ctx.governance.delegatedStakeTo(delegatee.address)).to.equal(0n);
      expect(await ctx.governance.delegatedStakeTo(newDelegatee.address)).to.equal(parseEther("4"));
    });

    it("delegatee can vote with combined power", async () => {
      await ctx.governance.connect(delegatee).deposit({ value: parseEther("1") });
      await ctx.governance.connect(delegator).deposit({ value: parseEther("9") });
      await advanceTime(ONE_HOUR + 1);

      await ctx.governance.connect(delegator).delegate(delegatee.address);

      await stakeAndWait(ctx.governance, proposer, "0.2");
      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Delegation voting"
      );

      await ctx.governance.connect(delegatee).castVote(proposalId, VoteType.For, "");
      const receipt = await ctx.governance.getReceipt(proposalId, delegatee.address);

      // Power should reflect combined 10 ETH → sqrt(10e9)
      const combined = await ctx.governance.getVotingPower(delegatee.address);
      expect(receipt.votes).to.equal(combined);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Failure Paths
  // ─────────────────────────────────────────────────────────────────────
  describe("Failure Paths", () => {
    it("should revert self-delegation", async () => {
      await ctx.governance.connect(delegator).deposit({ value: parseEther("1") });
      await expect(ctx.governance.connect(delegator).delegate(delegator.address))
        .to.be.revertedWith("Gov: self-delegation is a no-op; use undelegate()");
    });

    it("should revert delegation with zero stake", async () => {
      await expect(ctx.governance.connect(delegator).delegate(delegatee.address))
        .to.be.revertedWith("Gov: no stake to delegate");
    });

    it("should revert undelegation when not delegating", async () => {
      await ctx.governance.connect(delegator).deposit({ value: parseEther("1") });
      await expect(ctx.governance.connect(delegator).undelegate())
        .to.be.revertedWith("Gov: not delegating");
    });

    it("should prevent delegation loops (A→B where B already delegates)", async () => {
      const [,,,,,,,loopA, loopB] = await ethers.getSigners();
      await ctx.governance.connect(loopA).deposit({ value: parseEther("1") });
      await ctx.governance.connect(loopB).deposit({ value: parseEther("1") });

      // B delegates to A
      await ctx.governance.connect(loopB).delegate(loopA.address);

      // A tries to delegate to B — should be blocked (B is already delegating)
      await expect(ctx.governance.connect(loopA).delegate(loopB.address))
        .to.be.revertedWith("Gov: delegation chain not allowed");
    });

    it("should prevent delegator from voting directly", async () => {
      await ctx.governance.connect(delegator).deposit({ value: parseEther("4") });
      await ctx.governance.connect(delegatee).deposit({ value: parseEther("1") });
      await advanceTime(ONE_HOUR + 1);

      await ctx.governance.connect(delegator).delegate(delegatee.address);

      await stakeAndWait(ctx.governance, proposer, "0.2");
      const proposalId = await createProposal(
        ctx.governance, proposer,
        ProposalType.Operational, recipient.address, "0.5", "Delegator vote blocked"
      );

      await expect(
        ctx.governance.connect(delegator).castVote(proposalId, VoteType.For, "")
      ).to.be.revertedWith("Gov: delegator cannot vote directly; undelegate first");
    });

    it("should revert delegation to zero address", async () => {
      await ctx.governance.connect(delegator).deposit({ value: parseEther("1") });
      await expect(ctx.governance.connect(delegator).delegate(ethers.ZeroAddress))
        .to.be.revertedWith("Gov: zero delegatee");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Withdrawal With Delegation
  // ─────────────────────────────────────────────────────────────────────
  describe("Withdrawal With Active Delegation", () => {
    it("should reduce delegatee's delegated stake on withdrawal", async () => {
      await ctx.governance.connect(delegator).deposit({ value: parseEther("4") });
      await ctx.governance.connect(delegatee).deposit({ value: parseEther("1") });
      await ctx.governance.connect(delegator).delegate(delegatee.address);

      expect(await ctx.governance.delegatedStakeTo(delegatee.address)).to.equal(parseEther("4"));

      await ctx.governance.connect(delegator).withdraw(parseEther("2"));
      // delegatedStake should be reduced by 2
      expect(await ctx.governance.delegatedStakeTo(delegatee.address)).to.equal(parseEther("2"));
    });
  });
});
