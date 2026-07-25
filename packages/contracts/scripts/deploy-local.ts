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

  // Staking bond (registration sybil cost / slashable).
  const UNSTAKE_DELAY = 7 * 24 * 60 * 60; // 7-day dispute window
  const Bond = await ethers.getContractFactory('ComputeNodeStakingBond');
  const bond = await Bond.deploy(tokenAddress, deployer.address, deployer.address, UNSTAKE_DELAY);
  await bond.waitForDeployment();
  const bondAddress = await bond.getAddress();

  // Dispute market over results; slashed funds flow to the resolver, who may slash.
  const CHALLENGE_BOND = ethers.parseEther('100');
  const REWARD_BPS = 5000; // challenger gets 50% of an upheld slash
  const Resolver = await ethers.getContractFactory('DisputeResolver');
  const resolver = await Resolver.deploy(tokenAddress, bondAddress, deployer.address, CHALLENGE_BOND, REWARD_BPS, deployer.address);
  await resolver.waitForDeployment();
  const resolverAddress = await resolver.getAddress();
  await (await bond.setTreasury(resolverAddress)).wait();
  await (await bond.setSlasher(resolverAddress)).wait();

  /* eslint-disable no-console */
  console.log('NRN_TOKEN_ADDRESS=' + tokenAddress);
  console.log('COMPUTE_REWARD_VAULT_ADDRESS=' + vaultAddress);
  console.log('COMPUTE_NODE_STAKING_BOND_ADDRESS=' + bondAddress);
  console.log('DISPUTE_RESOLVER_ADDRESS=' + resolverAddress);
  console.log('VAULT_FUNDED_NRN=400000000');
  /* eslint-enable no-console */
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exitCode = 1;
});
