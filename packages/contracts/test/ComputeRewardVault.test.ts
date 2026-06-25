import { expect } from 'chai';
import { ethers } from 'hardhat';

const rewardId = (s: string) => ethers.id(s);

async function deploy() {
  const [owner, nodeOwner, stranger] = await ethers.getSigners();
  const Token = await ethers.getContractFactory('NRNToken');
  const token = await Token.deploy(owner.address);
  await token.waitForDeployment();
  const Vault = await ethers.getContractFactory('ComputeRewardVault');
  const vault = await Vault.deploy(await token.getAddress(), owner.address);
  await vault.waitForDeployment();
  // fund the vault
  await token.transfer(await vault.getAddress(), ethers.parseEther('1000'));
  return { token, vault, owner, nodeOwner, stranger };
}

describe('ComputeRewardVault', () => {
  it('pays a reward once', async () => {
    const { vault, token, nodeOwner } = await deploy();
    const amount = ethers.parseEther('10');
    await expect(vault.payReward(rewardId('r1'), nodeOwner.address, amount, 'job1'))
      .to.emit(vault, 'RewardPaid');
    expect(await token.balanceOf(nodeOwner.address)).to.equal(amount);
    expect(await vault.paidRewardIds(rewardId('r1'))).to.equal(true);
  });

  it('rejects a duplicate rewardId', async () => {
    const { vault, nodeOwner } = await deploy();
    const amount = ethers.parseEther('1');
    await vault.payReward(rewardId('dup'), nodeOwner.address, amount, 'job1');
    await expect(
      vault.payReward(rewardId('dup'), nodeOwner.address, amount, 'job1'),
    ).to.be.revertedWith('REWARD_ALREADY_PAID');
  });

  it('rejects the zero address', async () => {
    const { vault } = await deploy();
    await expect(
      vault.payReward(rewardId('z'), ethers.ZeroAddress, ethers.parseEther('1'), 'job1'),
    ).to.be.revertedWith('INVALID_NODE_OWNER');
  });

  it('rejects a non-owner caller', async () => {
    const { vault, nodeOwner, stranger } = await deploy();
    await expect(
      vault.connect(stranger).payReward(rewardId('x'), nodeOwner.address, ethers.parseEther('1'), 'job1'),
    ).to.be.reverted;
  });

  it('fails when the vault balance is insufficient', async () => {
    const { vault, nodeOwner } = await deploy();
    await expect(
      vault.payReward(rewardId('big'), nodeOwner.address, ethers.parseEther('100000'), 'job1'),
    ).to.be.reverted;
  });
});
