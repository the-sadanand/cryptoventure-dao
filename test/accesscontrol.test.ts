import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  deployDAO, DeployedContracts,
  fundTreasury,
} from "./helpers";

describe("DAOAccessControl", () => {
  let ctx: DeployedContracts;
  let admin: SignerWithAddress;
  let guardian: SignerWithAddress;
  let stranger: SignerWithAddress;
  let newGuardian: SignerWithAddress;

  beforeEach(async () => {
    [admin, guardian, stranger, newGuardian] = await ethers.getSigners();
    ctx = await deployDAO(admin, guardian);
    await fundTreasury(ctx.treasury, admin, "10");
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Role Assignment
  // ─────────────────────────────────────────────────────────────────────
  describe("Role Assignment at Deploy", () => {
    it("should grant DEFAULT_ADMIN_ROLE to admin", async () => {
      const role = await ctx.accessControl.DEFAULT_ADMIN_ROLE();
      expect(await ctx.accessControl.hasRole(role, admin.address)).to.be.true;
    });

    it("should grant GUARDIAN_ROLE to guardian", async () => {
      expect(await ctx.accessControl.isGuardian(guardian.address)).to.be.true;
    });

    it("should grant EXECUTOR_ROLE to governance", async () => {
      const govAddr = await ctx.governance.getAddress();
      expect(await ctx.accessControl.isExecutor(govAddr)).to.be.true;
    });

    it("should grant TREASURER_ROLE to governance", async () => {
      const govAddr = await ctx.governance.getAddress();
      expect(await ctx.accessControl.isTreasurer(govAddr)).to.be.true;
    });

    it("should NOT grant guardian role to stranger", async () => {
      expect(await ctx.accessControl.isGuardian(stranger.address)).to.be.false;
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Role Management
  // ─────────────────────────────────────────────────────────────────────
  describe("Role Management", () => {
    it("should allow admin to grant GUARDIAN_ROLE to new address", async () => {
      const GUARDIAN_ROLE = await ctx.accessControl.GUARDIAN_ROLE();
      await ctx.accessControl.connect(admin).grantRole(GUARDIAN_ROLE, newGuardian.address);
      expect(await ctx.accessControl.isGuardian(newGuardian.address)).to.be.true;
    });

    it("should allow admin to revoke GUARDIAN_ROLE", async () => {
      const GUARDIAN_ROLE = await ctx.accessControl.GUARDIAN_ROLE();
      await ctx.accessControl.connect(admin).revokeRole(GUARDIAN_ROLE, guardian.address);
      expect(await ctx.accessControl.isGuardian(guardian.address)).to.be.false;
    });

    it("should revert role grant from non-admin", async () => {
      const GUARDIAN_ROLE = await ctx.accessControl.GUARDIAN_ROLE();
      await expect(
        ctx.accessControl.connect(stranger).grantRole(GUARDIAN_ROLE, stranger.address)
      ).to.be.reverted;
    });

    it("should revert role revoke from non-admin", async () => {
      const GUARDIAN_ROLE = await ctx.accessControl.GUARDIAN_ROLE();
      await expect(
        ctx.accessControl.connect(stranger).revokeRole(GUARDIAN_ROLE, guardian.address)
      ).to.be.reverted;
    });

    it("should allow guardian to renounce their own role", async () => {
      const GUARDIAN_ROLE = await ctx.accessControl.GUARDIAN_ROLE();
      await ctx.accessControl.connect(guardian).renounceRole(GUARDIAN_ROLE, guardian.address);
      expect(await ctx.accessControl.isGuardian(guardian.address)).to.be.false;
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Role Restrictions on Contracts
  // ─────────────────────────────────────────────────────────────────────
  describe("Role Restrictions Enforced", () => {
    it("guardian can pause governance", async () => {
      await expect(ctx.governance.connect(guardian).pause()).to.not.be.reverted;
    });

    it("non-guardian cannot pause governance", async () => {
      await expect(ctx.governance.connect(stranger).pause())
        .to.be.revertedWith("Gov: not guardian");
    });

    it("guardian can pause treasury", async () => {
      await expect(ctx.treasury.connect(guardian).pause()).to.not.be.reverted;
    });

    it("non-guardian cannot pause treasury", async () => {
      await expect(ctx.treasury.connect(stranger).pause())
        .to.be.revertedWith("Treasury: not guardian");
    });

    it("stranger cannot queue in timelock directly", async () => {
      const opId = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(ctx.timelock.connect(stranger).queue(opId, 86400))
        .to.be.revertedWith("DAOTimelock: not executor");
    });

    it("stranger cannot mark executed in timelock", async () => {
      const opId = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(ctx.timelock.connect(stranger).markExecuted(opId))
        .to.be.revertedWith("DAOTimelock: not executor");
    });

    it("stranger cannot cancel in timelock", async () => {
      const opId = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(ctx.timelock.connect(stranger).cancel(opId))
        .to.be.revertedWith("DAOTimelock: not executor");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  //  Constructor Guards
  // ─────────────────────────────────────────────────────────────────────
  describe("Constructor Guards", () => {
    it("should revert DAOAccessControl with zero admin", async () => {
      const Factory = await ethers.getContractFactory("DAOAccessControl");
      await expect(
        Factory.deploy(ethers.ZeroAddress, guardian.address)
      ).to.be.revertedWith("DAOAccessControl: zero admin");
    });

    it("should revert DAOAccessControl with zero guardian", async () => {
      const Factory = await ethers.getContractFactory("DAOAccessControl");
      await expect(
        Factory.deploy(admin.address, ethers.ZeroAddress)
      ).to.be.revertedWith("DAOAccessControl: zero guardian");
    });

    it("should revert Treasury with zero access control", async () => {
      const Factory = await ethers.getContractFactory("Treasury");
      await expect(
        Factory.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("Treasury: zero access control");
    });

    it("should revert DAOTimelock with zero access control", async () => {
      const Factory = await ethers.getContractFactory("DAOTimelock");
      await expect(
        Factory.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("DAOTimelock: zero access control");
    });

    it("should revert DAOGovernance with zero treasury", async () => {
      const Factory = await ethers.getContractFactory("DAOGovernance");
      await expect(
        Factory.deploy(
          await ctx.accessControl.getAddress(),
          await ctx.calculator.getAddress(),
          ethers.ZeroAddress,
          await ctx.timelock.getAddress()
        )
      ).to.be.revertedWith("Gov: zero treasury");
    });
  });
});
