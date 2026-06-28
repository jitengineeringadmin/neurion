// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ComputeRewardVault is Ownable {
    IERC20 public immutable token;
    mapping(bytes32 => bool) public paidRewardIds;

    event RewardPaid(bytes32 indexed rewardId, address indexed nodeOwner, uint256 amount, string jobId);

    constructor(address tokenAddress, address initialOwner) Ownable(initialOwner) {
        token = IERC20(tokenAddress);
    }

    function payReward(bytes32 rewardId, address nodeOwner, uint256 amount, string calldata jobId) external onlyOwner {
        require(!paidRewardIds[rewardId], "REWARD_ALREADY_PAID");
        require(nodeOwner != address(0), "INVALID_NODE_OWNER");
        require(amount > 0, "INVALID_AMOUNT");
        require(bytes(jobId).length <= 256, "JOBID_TOO_LONG");
        require(token.balanceOf(address(this)) >= amount, "INSUFFICIENT_VAULT_BALANCE");
        paidRewardIds[rewardId] = true;
        require(token.transfer(nodeOwner, amount), "TRANSFER_FAILED");
        emit RewardPaid(rewardId, nodeOwner, amount, jobId);
    }
}
