import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { RefreshTokenService } from "./refresh-token.service";
import { AuthTokenService } from "./auth-token.service";

@Module({
  controllers: [AuthController],
  providers: [AuthService, RefreshTokenService, AuthTokenService],
  exports: [AuthService],
})
export class AuthModule {}
