import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { VAULT_ABI, TOKEN_ABI } from './crypto.constants';

@Injectable()
export class TokenConfigService {
  constructor(private readonly config: ConfigService) {}

  get chainId(): number {
    return Number(this.config.get('CHAIN_ID') ?? 31337);
  }
  get tokenAddress(): string {
    return this.config.get<string>('NRN_TOKEN_ADDRESS') ?? '';
  }
  get vaultAddress(): string {
    return this.config.get<string>('COMPUTE_REWARD_VAULT_ADDRESS') ?? '';
  }
  get creditToNrnWei(): string {
    return this.config.get<string>('CREDIT_TO_NRN_WEI') ?? '100000000000000000';
  }
  get payoutsEnabled(): boolean {
    return String(this.config.get('TOKEN_PAYOUTS_ENABLED') ?? 'false') === 'true';
  }

  publicConfig() {
    return {
      chainId: this.chainId,
      tokenAddress: this.tokenAddress || null,
      vaultAddress: this.vaultAddress || null,
      tokenSymbol: 'NRN',
      creditToNrnWei: this.creditToNrnWei,
      payoutsEnabled: this.payoutsEnabled,
      rpcUrl: this.config.get<string>('RPC_URL') ?? null,
    };
  }

  provider(): ethers.JsonRpcProvider {
    const rpc = this.config.get<string>('RPC_URL');
    if (!rpc) throw new ServiceUnavailableException('RPC_URL not configured');
    return new ethers.JsonRpcProvider(rpc);
  }

  signerVault(): ethers.Contract {
    const pk = this.config.get<string>('REWARD_SIGNER_PRIVATE_KEY');
    if (!pk || !this.vaultAddress) throw new ServiceUnavailableException('reward signer / vault not configured');
    const wallet = new ethers.Wallet(pk, this.provider());
    return new ethers.Contract(this.vaultAddress, VAULT_ABI, wallet);
  }

  token(): ethers.Contract {
    if (!this.tokenAddress) throw new ServiceUnavailableException('token not configured');
    return new ethers.Contract(this.tokenAddress, TOKEN_ABI, this.provider());
  }
}
