import { Body, Controller, Delete, ForbiddenException, Get, Injectable, Param, Post } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  create(user: AuthUser, name: string, path: string) {
    return this.prisma.project.create({ data: { workspaceId: user.workspaceId, userId: user.sub, name, path } });
  }
  list(user: AuthUser) {
    return this.prisma.project.findMany({ where: { userId: user.sub }, orderBy: { createdAt: 'desc' } });
  }
  async remove(user: AuthUser, id: string) {
    const p = await this.prisma.project.findUnique({ where: { id } });
    if (!p || p.userId !== user.sub) throw new ForbiddenException('not your project');
    await this.prisma.chatConversation.updateMany({ where: { projectId: id }, data: { projectId: null } });
    await this.prisma.project.delete({ where: { id } });
    return { ok: true };
  }
}

class CreateProjectDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsString()
  @MaxLength(500)
  path!: string;
}

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user, dto.name, dto.path);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.projects.list(user);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.remove(user, id);
  }
}
