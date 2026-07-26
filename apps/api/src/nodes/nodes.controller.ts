import { Body, Controller, Get, Ip, Param, Post } from "@nestjs/common";
import { IsArray, IsOptional, IsString, MaxLength } from "class-validator";
import { NodesService } from "./nodes.service";
import {
  CurrentUser,
  AuthUser,
} from "../common/decorators/current-user.decorator";

class RegisterNodeDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  supportedJobTypes?: string[];
}

@Controller("nodes")
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Post("register")
  register(
    @CurrentUser() user: AuthUser,
    @Body() dto: RegisterNodeDto,
    @Ip() ip: string,
  ) {
    return this.nodes.register(user, dto.name, dto.supportedJobTypes, ip);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.nodes.list(user);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.nodes.get(user, id);
  }

  @Get(":id/heartbeats")
  heartbeats(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.nodes.heartbeats(user, id);
  }

  @Post(":id/disable")
  disable(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.nodes.setEnabled(user, id, false);
  }

  @Post(":id/enable")
  enable(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.nodes.setEnabled(user, id, true);
  }
}
