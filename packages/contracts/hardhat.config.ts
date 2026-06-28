import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    localhost: {
      url: process.env.RPC_URL ?? 'http://127.0.0.1:8545',
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? '',
      accounts: process.env.REWARD_SIGNER_PRIVATE_KEY ? [process.env.REWARD_SIGNER_PRIVATE_KEY] : [],
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};

export default config;
