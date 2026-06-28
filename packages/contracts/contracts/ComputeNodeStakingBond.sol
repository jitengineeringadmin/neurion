// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * On-chain registration bond for compute nodes. An operator stakes NRN as
 * skin-in-the-game; the protocol owner (the verification authority) can slash a
 * proven-fraudulent operator's bond. Withdrawals have a cooldown (dispute
 * window) so a cheater can't unstake faster than fraud is detected.
 *
 * MVP trust model: the owner key is the slashing authority (off-chain real
 * verification is the proof). A trustless DisputeResolver replaces it later.
 */
contract ComputeNodeStakingBond is Ownable {
    IERC20 public immutable token;
    address public treasury; // destination of slashed funds
    address public slasher; // additional slashing authority (e.g. the DisputeResolver)
    uint256 public unstakeDelay; // dispute/cooldown window in seconds

    mapping(address => uint256) public bondOf;
    mapping(address => uint256) public unstakeReadyAt; // 0 = not requested

    event Staked(address indexed operator, uint256 amount, uint256 total);
    event UnstakeRequested(address indexed operator, uint256 readyAt);
    event Withdrawn(address indexed operator, uint256 amount);
    event Slashed(address indexed operator, uint256 amount, string reason);
    event TreasuryUpdated(address treasury);
    event SlasherUpdated(address slasher);
    event UnstakeDelayUpdated(uint256 delay);

    modifier onlyAuthority() {
        require(msg.sender == owner() || msg.sender == slasher, "NOT_AUTHORITY");
        _;
    }

    constructor(address tokenAddress, address initialOwner, address treasury_, uint256 unstakeDelay_) Ownable(initialOwner) {
        require(tokenAddress != address(0) && treasury_ != address(0), "ZERO_ADDR");
        token = IERC20(tokenAddress);
        treasury = treasury_;
        unstakeDelay = unstakeDelay_;
    }

    /// Deposit (more) bond. Cancels any pending unstake (re-locks the stake).
    function stake(uint256 amount) external {
        require(amount > 0, "ZERO_AMOUNT");
        bondOf[msg.sender] += amount;
        unstakeReadyAt[msg.sender] = 0;
        require(token.transferFrom(msg.sender, address(this), amount), "TRANSFER_FROM_FAILED");
        emit Staked(msg.sender, amount, bondOf[msg.sender]);
    }

    /// Start the cooldown before the bond can be withdrawn.
    function requestUnstake() external {
        require(bondOf[msg.sender] > 0, "NO_BOND");
        uint256 readyAt = block.timestamp + unstakeDelay;
        unstakeReadyAt[msg.sender] = readyAt;
        emit UnstakeRequested(msg.sender, readyAt);
    }

    /// Withdraw the full bond after the cooldown has elapsed.
    function withdraw() external {
        uint256 readyAt = unstakeReadyAt[msg.sender];
        require(readyAt != 0 && block.timestamp >= readyAt, "COOLDOWN");
        uint256 amount = bondOf[msg.sender];
        require(amount > 0, "NO_BOND");
        bondOf[msg.sender] = 0;
        unstakeReadyAt[msg.sender] = 0;
        require(token.transfer(msg.sender, amount), "TRANSFER_FAILED");
        emit Withdrawn(msg.sender, amount);
    }

    /// Slash a proven-fraudulent operator's bond (works even during cooldown).
    /// Callable by the owner or the configured slasher (the DisputeResolver).
    function slash(address operator, uint256 amount, string calldata reason) external onlyAuthority {
        require(amount > 0 && amount <= bondOf[operator], "BAD_AMOUNT");
        bondOf[operator] -= amount;
        require(token.transfer(treasury, amount), "TRANSFER_FAILED");
        emit Slashed(operator, amount, reason);
    }

    function setSlasher(address slasher_) external onlyOwner {
        slasher = slasher_;
        emit SlasherUpdated(slasher_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "ZERO_ADDR");
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setUnstakeDelay(uint256 delay) external onlyOwner {
        unstakeDelay = delay;
        emit UnstakeDelayUpdated(delay);
    }
}
