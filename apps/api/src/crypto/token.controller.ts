import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { IsInt, Min } from "class-validator";
import { TokenConfigService } from "./token-config.service";
import { TokenPayoutService } from "./token-payout.service";
import { Public } from "../common/decorators/public.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import {
  CurrentUser,
  AuthUser,
} from "../common/decorators/current-user.decorator";

class RequestPayoutDto {
  @IsInt()
  @Min(1)
  credits!: number;
}

@Controller("token")
export class TokenController {
  constructor(
    private readonly config: TokenConfigService,
    private readonly payouts: TokenPayoutService,
  ) {}

  @Public()
  @Get("config")
  tokenConfig() {
    return this.config.publicConfig();
  }

  @Get("payouts")
  list(@CurrentUser() user: AuthUser) {
    return this.payouts.listPayouts(user);
  }

  @Post("request-payout")
  request(@CurrentUser() user: AuthUser, @Body() dto: RequestPayoutDto) {
    return this.payouts.requestPayout(user, dto.credits);
  }

  @Get("payouts/:id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.payouts.getPayout(user, id);
  }

  @Post("admin/process-payouts")
  @Roles("SUPER_ADMIN", "ADMIN")
  process(@CurrentUser() user: AuthUser) {
    return this.payouts.processPayouts(user.sub);
  }
}
