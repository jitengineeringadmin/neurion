import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsEnum, IsObject, IsOptional, IsString } from 'class-validator';
import { JobPrivacyLevel } from '@prisma/client';
import { JobsService } from './jobs.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

class CreateJobDto {
  @IsString()
  type!: string;

  @IsObject()
  inputJson!: Record<string, unknown>;

  @IsOptional()
  @IsEnum(JobPrivacyLevel)
  privacyLevel?: JobPrivacyLevel;
}

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateJobDto) {
    return this.jobs.create(user, dto.type, dto.inputJson as never, dto.privacyLevel);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.jobs.list(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.jobs.get(user, id);
  }

  @Get(':id/events')
  events(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.jobs.events(user, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.jobs.cancel(user, id);
  }
}
