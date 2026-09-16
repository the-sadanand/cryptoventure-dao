import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const initialSupply = ethers.parseEther("1000000");
  const minDelay = 60;

  const Token = await ethers.getContractFactory("GovernanceToken");
  const token = await Token.deploy(initialSupply);
  await token.waitForDeployment();
  await (await token.delegate(deployer.address)).wait();

  const Timelock = await ethers.getContractFactory("@openzeppelin/contracts/governance/TimelockController.sol:TimelockController");
  const timelock = await Timelock.deploy(minDelay, [deployer.address], [ethers.ZeroAddress], deployer.address);
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

  console.log("GovernanceToken:", await token.getAddress());
  console.log("TimelockController:", await timelock.getAddress());
  console.log("MyGovernor:", await governor.getAddress());
  console.log("TreasuryProxy:", await treasury.getAddress());
  console.log("TreasuryImplementationV1:", await implementation.getAddress());
  console.log("Treasury balance:", ethers.formatEther(await treasury.balance()), "ETH");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
