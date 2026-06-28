import { expect } from 'chai';
import { ethers } from 'hardhat';

const DELAY = 7 * 24 * 60 * 60; // 7 days

async function deploy() {
  const [owner, operator, treasury, stranger] = await ethers.getSigners();
  const Token = await ethers.getContractFactory('NRNToken');
  const token = await Token.deploy(owner.address);
  await token.waitForDeployment();
  const Bond = await ethers.getContractFactory('ComputeNodeStakingBond');
  const bond = await Bond.deploy(await token.getAddress(), owner.address, treasury.address, DELAY);
  await bond.waitForDeployment();
  // fund the operator and approve the bond contract
  await token.transfer(operator.address, ethers.parseEther('100'));
  await token.connect(operator).approve(await bond.getAddress(), ethers.parseEther('100'));
  return { token, bond, owner, operator, treasury, stranger };
}

async function timeTravel(seconds: number) {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
}

describe('ComputeNodeStakingBond', () => {
  it('stakes a bond', async () => {
    const { bond, operator } = await deploy();
    const amount = ethers.parseEther('50');
    await expect(bond.connect(operator).stake(amount)).to.emit(bond, 'Staked');
    expect(await bond.bondOf(operator.address)).to.equal(amount);
  });

  it('owner can slash a fraudulent operator; funds go to treasury', async () => {
    const { token, bond, owner, operator, treasury } = await deploy();
    await bond.connect(operator).stake(ethers.parseEther('50'));
    await expect(bond.connect(owner).slash(operator.address, ethers.parseEther('30'), 'deep-fail'))
      .to.emit(bond, 'Slashed');
    expect(await bond.bondOf(operator.address)).to.equal(ethers.parseEther('20'));
    expect(await token.balanceOf(treasury.address)).to.equal(ethers.parseEther('30'));
  });

  it('rejects slashing by a non-owner', async () => {
    const { bond, operator, stranger } = await deploy();
    await bond.connect(operator).stake(ethers.parseEther('10'));
    await expect(bond.connect(stranger).slash(operator.address, ethers.parseEther('1'), 'x'))
      .to.be.revertedWithCustomError(bond, 'OwnableUnauthorizedAccount');
  });

  it('rejects slashing more than the bond', async () => {
    const { bond, owner, operator } = await deploy();
    await bond.connect(operator).stake(ethers.parseEther('10'));
    await expect(bond.connect(owner).slash(operator.address, ethers.parseEther('11'), 'x'))
      .to.be.revertedWith('BAD_AMOUNT');
  });

  it('cannot withdraw before the cooldown, can after', async () => {
    const { token, bond, operator } = await deploy();
    await bond.connect(operator).stake(ethers.parseEther('50'));
    await bond.connect(operator).requestUnstake();
    await expect(bond.connect(operator).withdraw()).to.be.revertedWith('COOLDOWN');
    await timeTravel(DELAY + 1);
    const before = await token.balanceOf(operator.address);
    await expect(bond.connect(operator).withdraw()).to.emit(bond, 'Withdrawn');
    expect(await token.balanceOf(operator.address)).to.equal(before + ethers.parseEther('50'));
    expect(await bond.bondOf(operator.address)).to.equal(0n);
  });

  it('can still slash during the unstake cooldown (no escape)', async () => {
    const { bond, owner, operator } = await deploy();
    await bond.connect(operator).stake(ethers.parseEther('50'));
    await bond.connect(operator).requestUnstake();
    await expect(bond.connect(owner).slash(operator.address, ethers.parseEther('50'), 'caught'))
      .to.emit(bond, 'Slashed');
    expect(await bond.bondOf(operator.address)).to.equal(0n);
  });
});
