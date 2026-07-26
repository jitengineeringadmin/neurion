import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { IsIn } from "class-validator";
import { NodeTrustLevel } from "@prisma/client";
import { AdminService } from "./admin.service";
import { Roles } from "../common/decorators/roles.decorator";

class TrustLevelDto {
  @IsIn(["COMMUNITY", "VERIFIED", "ENTERPRISE", "INTERNAL"])
  trustLevel!: NodeTrustLevel;
}

@Controller("admin")
@Roles("SUPER_ADMIN", "ADMIN")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("dashboard")
  dashboard() {
    return this.admin.dashboard();
  }

  @Patch("nodes/:id/trust-level")
  setTrustLevel(@Param("id") id: string, @Body() dto: TrustLevelDto) {
    return this.admin.setNodeTrustLevel(id, dto.trustLevel);
  }
}
