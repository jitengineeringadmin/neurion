import { Controller, Get, Query } from "@nestjs/common";
import { CreditsService } from "./credits.service";
import {
  CurrentUser,
  AuthUser,
} from "../common/decorators/current-user.decorator";

@Controller("credits")
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  @Get("balance")
  async balance(@CurrentUser() user: AuthUser) {
    return { balance: await this.credits.getBalance(user.sub) };
  }

  @Get("ledger")
  async ledger(@CurrentUser() user: AuthUser, @Query("take") take?: string) {
    const n = take ? Math.min(Number(take), 200) : 50;
    return this.credits.ledger(user.sub, n);
  }
}
