import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ForumCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';

const isMod = (role: string): boolean => role === 'ADMIN' || role === 'SUPER_ADMIN';
// Never expose full emails in a public forum — derive a handle.
const handle = (u: { displayName: string | null; email: string }): string =>
  (u.displayName && u.displayName.trim()) || u.email.split('@')[0] || 'user';

@Injectable()
export class ForumService {
  constructor(private readonly prisma: PrismaService) {}

  async listThreads(category?: ForumCategory) {
    const threads = await this.prisma.forumThread.findMany({
      where: category ? { category } : {},
      orderBy: [{ pinned: 'desc' }, { lastActivityAt: 'desc' }],
      take: 100,
      include: {
        author: { select: { id: true, displayName: true, email: true } },
        _count: { select: { posts: true } },
      },
    });
    return threads.map((t) => ({
      id: t.id,
      category: t.category,
      title: t.title,
      pinned: t.pinned,
      locked: t.locked,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
      author: { id: t.author.id, name: handle(t.author) },
      replies: t._count.posts,
    }));
  }

  async createThread(userId: string, data: { category: ForumCategory; title: string; body: string }) {
    const t = await this.prisma.forumThread.create({
      data: { authorId: userId, category: data.category, title: data.title.trim(), body: data.body },
    });
    return { id: t.id };
  }

  async getThread(id: string) {
    const t = await this.prisma.forumThread.findUnique({
      where: { id },
      include: {
        author: { select: { id: true, displayName: true, email: true } },
        posts: {
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { id: true, displayName: true, email: true } } },
        },
      },
    });
    if (!t) throw new NotFoundException('thread not found');
    return {
      id: t.id,
      category: t.category,
      title: t.title,
      body: t.body,
      pinned: t.pinned,
      locked: t.locked,
      createdAt: t.createdAt,
      author: { id: t.author.id, name: handle(t.author) },
      posts: t.posts.map((p) => ({
        id: p.id,
        body: p.body,
        createdAt: p.createdAt,
        author: { id: p.author.id, name: handle(p.author) },
      })),
    };
  }

  async reply(userId: string, threadId: string, body: string) {
    const t = await this.prisma.forumThread.findUnique({ where: { id: threadId } });
    if (!t) throw new NotFoundException('thread not found');
    if (t.locked) throw new ForbiddenException('thread is locked');
    const [post] = await this.prisma.$transaction([
      this.prisma.forumPost.create({ data: { threadId, authorId: userId, body } }),
      this.prisma.forumThread.update({ where: { id: threadId }, data: { lastActivityAt: new Date() } }),
    ]);
    return { id: post.id };
  }

  async deletePost(user: AuthUser, postId: string) {
    const p = await this.prisma.forumPost.findUnique({ where: { id: postId } });
    if (!p) throw new NotFoundException('post not found');
    if (p.authorId !== user.sub && !isMod(user.role)) throw new ForbiddenException('not allowed');
    await this.prisma.forumPost.delete({ where: { id: postId } });
    return { ok: true };
  }

  async deleteThread(user: AuthUser, threadId: string) {
    const t = await this.prisma.forumThread.findUnique({ where: { id: threadId } });
    if (!t) throw new NotFoundException('thread not found');
    if (t.authorId !== user.sub && !isMod(user.role)) throw new ForbiddenException('not allowed');
    await this.prisma.forumThread.delete({ where: { id: threadId } });
    return { ok: true };
  }

  async moderate(user: AuthUser, threadId: string, data: { pinned?: boolean; locked?: boolean }) {
    if (!isMod(user.role)) throw new ForbiddenException('moderators only');
    await this.prisma.forumThread.update({ where: { id: threadId }, data });
    return { ok: true };
  }
}
