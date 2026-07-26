import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { IsOptional, IsString } from "class-validator";
import { ComplianceService } from "./compliance.service";
import { Roles } from "../common/decorators/roles.decorator";
import {
  CurrentUser,
  AuthUser,
} from "../common/decorators/current-user.decorator";

class BlockDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

@Controller("admin/compliance")
@Roles("SUPER_ADMIN", "ADMIN", "COMPLIANCE")
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get()
  list() {
    return this.compliance.listRecords();
  }

  @Post(":userId/block-payouts")
  block(
    @CurrentUser() admin: AuthUser,
    @Param("userId") userId: string,
    @Body() dto: BlockDto,
  ) {
    return this.compliance.blockPayouts(admin.sub, userId, dto.reason);
  }

  @Post(":userId/unblock-payouts")
  unblock(@CurrentUser() admin: AuthUser, @Param("userId") userId: string) {
    return this.compliance.unblockPayouts(admin.sub, userId);
  }
}
