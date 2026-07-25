import { Module } from '@nestjs/common';
import { TokenConfigService } from './token-config.service';
import { WalletAuthService } from './wallet-auth.service';
import { TokenPayoutService } from './token-payout.service';
import { EmissionService } from './emission.service';
import { WalletController } from './wallet.controller';
import { TokenController } from './token.controller';

@Module({
  controllers: [WalletController, TokenController],
  providers: [TokenConfigService, WalletAuthService, TokenPayoutService, EmissionService],
  exports: [TokenConfigService],
})
export class CryptoModule {}
