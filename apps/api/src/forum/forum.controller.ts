import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ForumCategory } from '@prisma/client';
import { ForumService } from './forum.service';
import { CreateThreadDto, ReplyDto, ModerateDto } from './dto/forum.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@Controller('forum')
export class ForumController {
  constructor(private readonly forum: ForumService) {}

  @Public()
  @Get('threads')
  list(@Query('category') category?: string) {
    const cat =
      category && (Object.values(ForumCategory) as string[]).includes(category)
        ? (category as ForumCategory)
        : undefined;
    return this.forum.listThreads(cat);
  }

  @Public()
  @Get('threads/:id')
  get(@Param('id') id: string) {
    return this.forum.getThread(id);
  }

  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post('threads')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateThreadDto) {
    return this.forum.createThread(user.sub, dto);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('threads/:id/posts')
  reply(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReplyDto) {
    return this.forum.reply(user.sub, id, dto.body);
  }

  @Delete('posts/:id')
  deletePost(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.forum.deletePost(user, id);
  }

  @Delete('threads/:id')
  deleteThread(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.forum.deleteThread(user, id);
  }

  @Patch('threads/:id')
  moderate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ModerateDto) {
    return this.forum.moderate(user, id, dto);
  }
}
