import { ethers } from "hardhat";
import { parseEther } from "ethers";

/**
 * deploy.ts
 *
 * Full deployment script for CryptoVentures DAO.
 *
 * Deployment order (dependency-safe):
 *   1. DAOAccessControl
 *   2. VotingPowerCalculator
 *   3. Treasury
 *   4. DAOTimelock
 *   5. DAOGovernance
 *   6. Role wiring
 *   7. Seed state (treasury fund + sample stake)
 */
async function main() {
  const [deployer, guardian, user1, user2] = await ethers.getSigners();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  CryptoVentures DAO — Deployment");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Guardian:  ${guardian.address}`);
  console.log(`  Network:   ${(await ethers.provider.getNetwork()).name}`);
  console.log("───────────────────────────────────────────────────────────\n");

  // ────────────────────────────────────────────────────────────────────
  // 1. DAOAccessControl
  // ────────────────────────────────────────────────────────────────────
  console.log("📦 Deploying DAOAccessControl...");
  const AccessControl = await ethers.getContractFactory("DAOAccessControl");
  const accessControl = await AccessControl.deploy(
    deployer.address,   // admin (will be transferred to multisig post-deploy)
    guardian.address    // guardian
  );
  await accessControl.waitForDeployment();
  const accessControlAddr = await accessControl.getAddress();
  console.log(`   ✅ DAOAccessControl: ${accessControlAddr}`);

  // ────────────────────────────────────────────────────────────────────
  // 2. VotingPowerCalculator
  // ────────────────────────────────────────────────────────────────────
  console.log("📦 Deploying VotingPowerCalculator...");
  const Calculator = await ethers.getContractFactory("VotingPowerCalculator");
  const calculator = await Calculator.deploy();
  await calculator.waitForDeployment();
  const calculatorAddr = await calculator.getAddress();
  console.log(`   ✅ VotingPowerCalculator: ${calculatorAddr}`);

  // ────────────────────────────────────────────────────────────────────
  // 3. Treasury
  // ────────────────────────────────────────────────────────────────────
  console.log("📦 Deploying Treasury...");
  const TreasuryFactory = await ethers.getContractFactory("Treasury");
  const treasury = await TreasuryFactory.deploy(accessControlAddr);
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log(`   ✅ Treasury: ${treasuryAddr}`);

  // ────────────────────────────────────────────────────────────────────
  // 4. DAOTimelock
  // ────────────────────────────────────────────────────────────────────
  console.log("📦 Deploying DAOTimelock...");
  const TimelockFactory = await ethers.getContractFactory("DAOTimelock");
  const timelock = await TimelockFactory.deploy(accessControlAddr);
  await timelock.waitForDeployment();
  const timelockAddr = await timelock.getAddress();
  console.log(`   ✅ DAOTimelock: ${timelockAddr}`);

  // ────────────────────────────────────────────────────────────────────
  // 5. DAOGovernance
  // ────────────────────────────────────────────────────────────────────
  console.log("📦 Deploying DAOGovernance...");
  const GovernanceFactory = await ethers.getContractFactory("DAOGovernance");
  const governance = await GovernanceFactory.deploy(
    accessControlAddr,
    calculatorAddr,
    treasuryAddr,
    timelockAddr
  );
  await governance.waitForDeployment();
  const governanceAddr = await governance.getAddress();
  console.log(`   ✅ DAOGovernance: ${governanceAddr}`);

  // ────────────────────────────────────────────────────────────────────
  // 6. Role Wiring
  // ────────────────────────────────────────────────────────────────────
  console.log("\n🔐 Configuring roles...");

  const EXECUTOR_ROLE  = await accessControl.EXECUTOR_ROLE();
  const TREASURER_ROLE = await accessControl.TREASURER_ROLE();

  // DAOGovernance gets EXECUTOR_ROLE (to call timelock.queue / markExecuted / cancel)
  let tx = await accessControl.grantRole(EXECUTOR_ROLE, governanceAddr);
  await tx.wait();
  console.log(`   ✅ Granted EXECUTOR_ROLE  → DAOGovernance`);

  // DAOGovernance gets TREASURER_ROLE (to call treasury.transfer)
  tx = await accessControl.grantRole(TREASURER_ROLE, governanceAddr);
  await tx.wait();
  console.log(`   ✅ Granted TREASURER_ROLE → DAOGovernance`);

  // ────────────────────────────────────────────────────────────────────
  // 7. Seed State
  // ────────────────────────────────────────────────────────────────────
  console.log("\n🌱 Seeding initial state...");

  // Fund the treasury with 10 ETH from the deployer
  tx = await deployer.sendTransaction({
    to: treasuryAddr,
    value: parseEther("10"),
  });
  await tx.wait();
  const treasuryBalance = await ethers.provider.getBalance(treasuryAddr);
  console.log(`   ✅ Treasury funded: ${ethers.formatEther(treasuryBalance)} ETH`);

  // user1 stakes 1 ETH
  if (user1) {
    tx = await governance.connect(user1).deposit({ value: parseEther("1") });
    await tx.wait();
    console.log(`   ✅ ${user1.address.slice(0, 8)}… staked 1 ETH`);
  }

  // user2 stakes 4 ETH
  if (user2) {
    tx = await governance.connect(user2).deposit({ value: parseEther("4") });
    await tx.wait();
    console.log(`   ✅ ${user2.address.slice(0, 8)}… staked 4 ETH`);
  }

  // ────────────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Deployment Complete — Contract Addresses");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  DAOAccessControl:      ${accessControlAddr}`);
  console.log(`  VotingPowerCalculator: ${calculatorAddr}`);
  console.log(`  Treasury:              ${treasuryAddr}`);
  console.log(`  DAOTimelock:           ${timelockAddr}`);
  console.log(`  DAOGovernance:         ${governanceAddr}`);
  console.log("───────────────────────────────────────────────────────────");
  console.log(`  Treasury Balance: ${ethers.formatEther(await ethers.provider.getBalance(treasuryAddr))} ETH`);
  console.log(`  Total Staked:     ${ethers.formatEther(await governance.totalStaked())} ETH`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Return addresses for programmatic use
  return {
    accessControl: accessControlAddr,
    calculator:    calculatorAddr,
    treasury:      treasuryAddr,
    timelock:      timelockAddr,
    governance:    governanceAddr,
  };
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Deployment failed:", err);
    process.exit(1);
  });
