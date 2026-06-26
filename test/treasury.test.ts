import { expect } from "chai";
import { ethers } from "hardhat";
import { parseEther } from "ethers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  deployDAO, DeployedContracts,
  ProposalType, VoteType,
  stakeAndWait, fundTreasury, advanceTime,
  ONE_HOUR, ONE_DAY,
} from "./helpers";

describe("Treasury", () => {
  let ctx: DeployedContracts;
  let admin: SignerWithAddress;
  let guardian: SignerWithAddress;
  let proposer: SignerWithAddress;
  let voter1: SignerWithAddress;
  let recipient: SignerWithAddress;
  let attacker: SignerWithAddress;

  beforeEach(async () => {
    [admin, guardian, proposer, voter1, recipient, attacker] = await ethers.getSigners();
    ctx = await deployDAO(admin, guardian);
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Deposits
  // ─────────────────────────────────────────────────────────────────────
  describe("Deposits", () => {
    it("should accept ETH via receive()", async () => {
      await admin.sendTransaction({ to: await ctx.treasury.getAddress(), value: parseEther("5") });
      expect(await ctx.treasury.balance()).to.equal(parseEther("5"));
    });

    it("should emit TreasuryDeposit on receive", async () => {
      const treasuryAddr = await ctx.treasury.getAddress();
      await expect(
        admin.sendTransaction({ to: treasuryAddr, value: parseEther("1") })
      ).to.emit(ctx.treasury, "TreasuryDeposit").withArgs(admin.address, parseEther("1"));
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Allocation Caps
  // ─────────────────────────────────────────────────────────────────────
  describe("Allocation Caps", () => {
    beforeEach(async () => {
      await fundTreasury(ctx.treasury, admin, "10");
    });

    it("should return 60% of balance for HighConviction", async () => {
      const max = await ctx.treasury.maxAllocation(0);
      expect(max).to.equal(parseEther("6")); // 60% of 10 ETH
    });

    it("should return 30% of balance for Experimental", async () => {
      const max = await ctx.treasury.maxAllocation(1);
      expect(max).to.equal(parseEther("3")); // 30% of 10 ETH
    });

    it("should return 10% of balance for Operational", async () => {
      const max = await ctx.treasury.maxAllocation(2);
      expect(max).to.equal(parseEther("1")); // 10% of 10 ETH
    });

    it("should validate allocation correctly", async () => {
      expect(await ctx.treasury.validateAllocation(2, parseEther("0.5"))).to.be.true;  // within 10%
      expect(await ctx.treasury.validateAllocation(2, parseEther("1.1"))).to.be.false; // over 10%
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Transfer (via governance)
  // ─────────────────────────────────────────────────────────────────────
  describe("Transfer via Governance", () => {
    it("should emit TreasuryTransfer on successful execution", async () => {
      await fundTreasury(ctx.treasury, admin, "10");
      await stakeAndWait(ctx.governance, proposer, "0.2");
      await stakeAndWait(ctx.governance, voter1, "4");

      const amount = parseEther("0.5");
      const tx = await ctx.governance.connect(proposer).propose(
        ProposalType.Operational, recipient.address, amount, "Treasury transfer"
      );
      await tx.wait();

      await ctx.governance.connect(voter1).castVote(1n, VoteType.For, "");
      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);
      await ctx.governance.queue(1n);
      await advanceTime(Number(cfg.timelockSeconds) + 1);

      await expect(ctx.governance.execute(1n))
        .to.emit(ctx.treasury, "TreasuryTransfer")
        .withArgs(recipient.address, amount, 1n, (rem: bigint) => rem > 0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Unauthorized Access
  // ─────────────────────────────────────────────────────────────────────
  describe("Unauthorized Access", () => {
    it("should revert direct transfer call from attacker", async () => {
      await fundTreasury(ctx.treasury, admin, "10");
      await expect(
        ctx.treasury.connect(attacker).transfer(
          recipient.address, parseEther("1"), 1n, 2
        )
      ).to.be.revertedWith("Treasury: caller is not treasurer");
    });

    it("should revert direct transfer call from admin", async () => {
      await fundTreasury(ctx.treasury, admin, "10");
      await expect(
        ctx.treasury.connect(admin).transfer(
          recipient.address, parseEther("1"), 1n, 2
        )
      ).to.be.revertedWith("Treasury: caller is not treasurer");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Insufficient Balance
  // ─────────────────────────────────────────────────────────────────────
  describe("Insufficient Treasury", () => {
    it("should revert proposal if treasury balance is too low for cap", async () => {
      // Treasury has 0.5 ETH; Operational cap = 10% = 0.05 ETH
      // Request 0.1 ETH — exceeds cap
      await admin.sendTransaction({ to: await ctx.treasury.getAddress(), value: parseEther("0.5") });
      await stakeAndWait(ctx.governance, proposer, "0.2");

      await expect(
        ctx.governance.connect(proposer).propose(
          ProposalType.Operational,
          recipient.address,
          parseEther("0.1"),
          "Too much"
        )
      ).to.be.revertedWith("Gov: amount exceeds treasury allocation cap");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Pause
  // ─────────────────────────────────────────────────────────────────────
  describe("Pause", () => {
    it("should pause and block transfers", async () => {
      await fundTreasury(ctx.treasury, admin, "10");
      await ctx.treasury.connect(guardian).pause();

      // Governance execution should fail because treasury is paused
      await stakeAndWait(ctx.governance, proposer, "0.2");
      await stakeAndWait(ctx.governance, voter1, "4");

      const tx = await ctx.governance.connect(proposer).propose(
        ProposalType.Operational, recipient.address, parseEther("0.5"), "Paused treasury"
      );
      await tx.wait();

      await ctx.governance.connect(voter1).castVote(1n, VoteType.For, "");
      const cfg = await ctx.governance.getTypeConfig(Number(ProposalType.Operational));
      await advanceTime(Number(cfg.votingPeriodSeconds) + 1);
      await ctx.governance.queue(1n);
      await advanceTime(Number(cfg.timelockSeconds) + 1);

      await expect(ctx.governance.execute(1n)).to.be.reverted; // treasury is paused
    });

    it("should unpause and allow transfers again", async () => {
      await fundTreasury(ctx.treasury, admin, "10");
      await ctx.treasury.connect(guardian).pause();
      await ctx.treasury.connect(guardian).unpause();
      expect(await ctx.treasury.balance()).to.equal(parseEther("10"));
    });

    it("should revert pause from non-guardian", async () => {
      await expect(ctx.treasury.connect(attacker).pause())
        .to.be.revertedWith("Treasury: not guardian");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Admin — Allocation Cap Update
  // ─────────────────────────────────────────────────────────────────────
  describe("Admin: Update Allocation Caps", () => {
    it("should allow admin to update allocation cap", async () => {
      await fundTreasury(ctx.treasury, admin, "10");
      await ctx.treasury.connect(admin).setAllocationCap(2, 2000); // 20%

      const max = await ctx.treasury.maxAllocation(2);
      expect(max).to.equal(parseEther("2")); // 20% of 10 ETH
    });

    it("should revert cap update from non-admin", async () => {
      await expect(ctx.treasury.connect(attacker).setAllocationCap(2, 2000))
        .to.be.revertedWith("Treasury: not admin");
    });

    it("should revert cap update above 100%", async () => {
      await expect(ctx.treasury.connect(admin).setAllocationCap(2, 10_001))
        .to.be.revertedWith("Treasury: cap exceeds 100%");
    });
  });
});
