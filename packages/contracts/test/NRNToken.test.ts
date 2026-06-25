import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('NRNToken', () => {
  it('mints the full max supply to the initial owner', async () => {
    const [owner] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('NRNToken');
    const token = await Token.deploy(owner.address);
    await token.waitForDeployment();

    const max = ethers.parseEther('1000000000');
    expect(await token.MAX_SUPPLY()).to.equal(max);
    expect(await token.totalSupply()).to.equal(max);
    expect(await token.balanceOf(owner.address)).to.equal(max);
    expect(await token.name()).to.equal('Neurion');
    expect(await token.symbol()).to.equal('NRN');
  });
});
