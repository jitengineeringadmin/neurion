// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Linear vesting with cliff for a single beneficiary (team/advisors).
contract VestingVault is Ownable {
    IERC20 public immutable token;
    address public immutable beneficiary;
    uint64 public immutable start;
    uint64 public immutable cliff;
    uint64 public immutable duration;
    uint256 public released;

    event Released(uint256 amount);

    constructor(
        address tokenAddress,
        address beneficiary_,
        uint64 startTimestamp,
        uint64 cliffSeconds,
        uint64 durationSeconds,
        address initialOwner
    ) Ownable(initialOwner) {
        require(beneficiary_ != address(0), "INVALID_BENEFICIARY");
        token = IERC20(tokenAddress);
        beneficiary = beneficiary_;
        start = startTimestamp;
        cliff = startTimestamp + cliffSeconds;
        duration = durationSeconds;
    }

    function vestedAmount(uint64 timestamp) public view returns (uint256) {
        uint256 totalAllocation = token.balanceOf(address(this)) + released;
        if (timestamp < cliff) {
            return 0;
        }
        if (timestamp >= start + duration) {
            return totalAllocation;
        }
        return (totalAllocation * (timestamp - start)) / duration;
    }

    function releasable() public view returns (uint256) {
        return vestedAmount(uint64(block.timestamp)) - released;
    }

    function release() external {
        uint256 amount = releasable();
        require(amount > 0, "NOTHING_TO_RELEASE");
        released += amount;
        require(token.transfer(beneficiary, amount), "TRANSFER_FAILED");
        emit Released(amount);
    }
}
