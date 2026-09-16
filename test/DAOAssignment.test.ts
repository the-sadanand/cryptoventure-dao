import { expect } from "chai";
import { ethers } from "hardhat";

async function mine(blocks: number) {
  for (let i = 0; i < blocks; i++) await ethers.provider.send("evm_mine", []);
}

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("DAO assignment: governance + timelock + treasury upgrade", function () {
  async function deploySystem() {
    const [deployer, recipient] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("GovernanceToken");
    const token = await Token.deploy(ethers.parseEther("1000000"));
    await token.waitForDeployment();
    await (await token.delegate(deployer.address)).wait();

    const Timelock = await ethers.getContractFactory("@openzeppelin/contracts/governance/TimelockController.sol:TimelockController");
    const timelock = await Timelock.deploy(60, [deployer.address], [ethers.ZeroAddress], deployer.address);
    await timelock.waitForDeployment();

    const Governor = await ethers.getContractFactory("MyGovernor");
    const governor = await Governor.deploy(await token.getAddress(), await timelock.getAddress());
    await governor.waitForDeployment();

    const proposerRole = await timelock.PROPOSER_ROLE();
    const cancellerRole = await timelock.CANCELLER_ROLE();
    const adminRole = await timelock.DEFAULT_ADMIN_ROLE();
    await (await timelock.grantRole(proposerRole, await governor.getAddress())).wait();
    await (await timelock.grantRole(cancellerRole, await governor.getAddress())).wait();
    await (await timelock.revokeRole(proposerRole, deployer.address)).wait();
    await (await timelock.revokeRole(cancellerRole, deployer.address)).wait();
    await (await timelock.renounceRole(adminRole, deployer.address)).wait();

    const TreasuryImpl = await ethers.getContractFactory("contracts/task/Treasury.sol:Treasury");
    const implementation = await TreasuryImpl.deploy();
    await implementation.waitForDeployment();
    const initData = TreasuryImpl.interface.encodeFunctionData("initialize", [await timelock.getAddress()]);
    const Proxy = await ethers.getContractFactory("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy");
    const proxy = await Proxy.deploy(await implementation.getAddress(), initData);
    await proxy.waitForDeployment();
    const treasury = TreasuryImpl.attach(await proxy.getAddress());
    await deployer.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("10") });

    return { deployer, recipient, token, timelock, governor, treasury, TreasuryImpl };
  }

  async function passProposal(governor: any, targets: string[], values: bigint[], calldatas: string[], description: string) {
    await (await governor.propose(targets, values, calldatas, description)).wait();
    const proposalId = await governor.hashProposal(targets, values, calldatas, ethers.id(description));
    await mine(2);
    await (await governor.castVote(proposalId, 1)).wait();
    await mine(6);
    expect(await governor.state(proposalId)).to.equal(4); // Succeeded
    await (await governor.queue(targets, values, calldatas, ethers.id(description))).wait();
    expect(await governor.state(proposalId)).to.equal(5); // Queued
    return proposalId;
  }

  it("runs proposal -> vote -> queue -> timelock -> execute for an ETH transfer", async function () {
    const { governor, treasury, recipient } = await deploySystem();
    const amount = ethers.parseEther("1");
    const calldata = treasury.interface.encodeFunctionData("transferETH", [recipient.address, amount]);
    const description = "Transfer 1 ETH from treasury";

    await passProposal(governor, [await treasury.getAddress()], [0n], [calldata], description);
    await increaseTime(61);
    const before = await ethers.provider.getBalance(recipient.address);
    await (await governor.execute([await treasury.getAddress()], [0n], [calldata], ethers.id(description))).wait();
    const after = await ethers.provider.getBalance(recipient.address);

    expect(after - before).to.equal(amount);
    expect(await treasury.balance()).to.equal(ethers.parseEther("9"));
  });

  it("upgrades the treasury through a successful governance proposal and preserves balance", async function () {
    const { governor, treasury, timelock } = await deploySystem();
    expect(await treasury.version()).to.equal(1n);
    const balanceBefore = await treasury.balance();

    const TreasuryV2 = await ethers.getContractFactory("TreasuryV2");
    const v2 = await TreasuryV2.deploy();
    await v2.waitForDeployment();

    const calldata = treasury.interface.encodeFunctionData("upgradeToAndCall", [await v2.getAddress(), "0x"]);
    const description = "Upgrade treasury implementation to V2";

    await passProposal(governor, [await treasury.getAddress()], [0n], [calldata], description);
    await increaseTime(61);
    await (await governor.execute([await treasury.getAddress()], [0n], [calldata], ethers.id(description))).wait();

    const upgradedTreasury = TreasuryV2.attach(await treasury.getAddress());
    expect(await upgradedTreasury.version()).to.equal(2n);
    expect(await upgradedTreasury.balance()).to.equal(balanceBefore);
    expect(await upgradedTreasury.owner()).to.equal(await timelock.getAddress());
  });
});
