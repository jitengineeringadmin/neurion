import { ethers } from 'hardhat';

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();

  const Token = await ethers.getContractFactory('NRNToken');
  const token = await Token.deploy(deployer.address);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  const Vault = await ethers.getContractFactory('ComputeRewardVault');
  const vault = await Vault.deploy(tokenAddress, deployer.address);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  // Fund the reward vault from the Compute Rewards Pool (40% of supply for MVP demo).
  const fund = ethers.parseEther('400000000');
  await (await token.transfer(vaultAddress, fund)).wait();

  // eslint-disable-next-line no-console
  console.log('NRN_TOKEN_ADDRESS=' + tokenAddress);
  // eslint-disable-next-line no-console
  console.log('COMPUTE_REWARD_VAULT_ADDRESS=' + vaultAddress);
  // eslint-disable-next-line no-console
  console.log('VAULT_FUNDED_NRN=400000000');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exitCode = 1;
});
