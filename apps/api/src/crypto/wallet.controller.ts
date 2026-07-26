import { Body, Controller, Get, Post } from "@nestjs/common";
import { IsEthereumAddress, IsString } from "class-validator";
import { WalletAuthService } from "./wallet-auth.service";
import {
  CurrentUser,
  AuthUser,
} from "../common/decorators/current-user.decorator";

class NonceDto {
  @IsEthereumAddress()
  address!: string;
}
class VerifyDto {
  @IsEthereumAddress()
  address!: string;

  @IsString()
  nonce!: string;

  @IsString()
  signature!: string;
}

@Controller("wallet")
export class WalletController {
  constructor(private readonly wallet: WalletAuthService) {}

  @Post("nonce")
  nonce(@Body() dto: NonceDto) {
    return this.wallet.createNonce(dto.address);
  }

  @Post("verify")
  verify(@CurrentUser() user: AuthUser, @Body() dto: VerifyDto) {
    return this.wallet.verify(user.sub, dto.address, dto.nonce, dto.signature);
  }

  @Post("disconnect")
  disconnect(@CurrentUser() user: AuthUser) {
    return this.wallet.disconnect(user.sub);
  }

  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return this.wallet.me(user.sub);
  }
}
