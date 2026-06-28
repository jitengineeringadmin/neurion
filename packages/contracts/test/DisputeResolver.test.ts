import { expect } from 'chai';
import { ethers } from 'hardhat';

const E = (n: string) => ethers.parseEther(n);
const CHALLENGE_BOND = E('10');
const REWARD_BPS = 5000n; // 50% of an upheld slash goes to the challenger

async function deploy() {
  const [owner, operator, challenger, treasury] = await ethers.getSigners();
  const Token = await ethers.getContractFactory('NRNToken');
  const token = await Token.deploy(owner.address);
  await token.waitForDeployment();

  const Bond = await ethers.getContractFactory('ComputeNodeStakingBond');
  const bond = await Bond.deploy(await token.getAddress(), owner.address, owner.address, 7 * 24 * 3600);
  await bond.waitForDeployment();

  const Resolver = await ethers.getContractFactory('DisputeResolver');
  const resolver = await Resolver.deploy(
    await token.getAddress(),
    await bond.getAddress(),
    treasury.address,
    CHALLENGE_BOND,
    REWARD_BPS,
    owner.address,
  );
  await resolver.waitForDeployment();

  // wire: slashed funds flow to the resolver, and the resolver may slash
  await bond.setTreasury(await resolver.getAddress());
  await bond.setSlasher(await resolver.getAddress());

  // operator stakes; challenger funded + approves the resolver
  await token.transfer(operator.address, E('100'));
  await token.connect(operator).approve(await bond.getAddress(), E('100'));
  await bond.connect(operator).stake(E('50'));
  await token.transfer(challenger.address, E('100'));
  await token.connect(challenger).approve(await resolver.getAddress(), E('100'));

  const jobId = ethers.id('job1');
  const disputeId = (op: string, ch: string) =>
    ethers.solidityPackedKeccak256(['address', 'bytes32', 'address'], [op, jobId, ch]);

  return { token, bond, resolver, owner, operator, challenger, treasury, jobId, disputeId };
}

describe('DisputeResolver', () => {
  it('opens a bonded dispute', async () => {
    const { resolver, token, operator, challenger, jobId } = await deploy();
    await expect(resolver.connect(challenger).openDispute(operator.address, jobId, 'ipfs://evidence'))
      .to.emit(resolver, 'DisputeOpened');
    expect(await token.balanceOf(await resolver.getAddress())).to.equal(CHALLENGE_BOND);
    expect(await resolver.jobDisputed(jobId)).to.equal(true);
  });

  it('upheld: operator slashed, challenger refunded + rewarded, remainder to treasury', async () => {
    const { resolver, bond, token, owner, operator, challenger, treasury, jobId, disputeId } = await deploy();
    await resolver.connect(challenger).openDispute(operator.address, jobId, 'e');
    const slash = E('20');
    await expect(resolver.connect(owner).resolve(disputeId(operator.address, challenger.address), true, slash))
      .to.emit(resolver, 'DisputeResolved');
    expect(await bond.bondOf(operator.address)).to.equal(E('30')); // 50 - 20
    // challenger: started 100, staked 10 -> 90, then refunded 10 + reward 10 (50% of 20) = 110
    expect(await token.balanceOf(challenger.address)).to.equal(E('110'));
    // treasury: slash 20 - reward 10 = 10
    expect(await token.balanceOf(treasury.address)).to.equal(E('10'));
  });

  it('rejected: frivolous challenger forfeits the bond to the treasury', async () => {
    const { resolver, token, owner, operator, challenger, treasury, jobId, disputeId } = await deploy();
    await resolver.connect(challenger).openDispute(operator.address, jobId, 'e');
    await resolver.connect(owner).resolve(disputeId(operator.address, challenger.address), false, 0);
    expect(await token.balanceOf(challenger.address)).to.equal(E('90')); // lost the 10 bond
    expect(await token.balanceOf(treasury.address)).to.equal(CHALLENGE_BOND);
  });

  it('only the arbiter (owner) can resolve', async () => {
    const { resolver, operator, challenger, jobId, disputeId } = await deploy();
    await resolver.connect(challenger).openDispute(operator.address, jobId, 'e');
    await expect(
      resolver.connect(challenger).resolve(disputeId(operator.address, challenger.address), true, E('1')),
    ).to.be.revertedWithCustomError(resolver, 'OwnableUnauthorizedAccount');
  });

  it('rejects a second dispute on the same job', async () => {
    const { resolver, operator, challenger, jobId } = await deploy();
    await resolver.connect(challenger).openDispute(operator.address, jobId, 'e');
    await expect(resolver.connect(challenger).openDispute(operator.address, jobId, 'e')).to.be.revertedWith('ALREADY_DISPUTED');
  });
});
