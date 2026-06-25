export const VAULT_ABI = [
  'function payReward(bytes32 rewardId, address nodeOwner, uint256 amount, string jobId) external',
  'function paidRewardIds(bytes32) view returns (bool)',
  'event RewardPaid(bytes32 indexed rewardId, address indexed nodeOwner, uint256 amount, string jobId)',
];

export const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];
