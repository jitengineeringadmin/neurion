import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';

const isMod = (role: string): boolean => role === 'ADMIN' || role === 'SUPER_ADMIN';
const handle = (u: { displayName: string | null; email: string }): string =>
  (u.displayName && u.displayName.trim()) || u.email.split('@')[0] || 'user';

@Injectable()
export class ForumService {
  constructor(private readonly prisma: PrismaService) {}

  /** Board home: every section (grouped, ordered) with thread/message counts + last post. */
  async sections() {
    const sections = await this.prisma.forumSection.findMany({ orderBy: { order: 'asc' } });
    const threads = await this.prisma.forumThread.findMany({
      orderBy: { lastActivityAt: 'desc' },
      include: { author: { select: { displayName: true, email: true, avatarUrl: true } }, _count: { select: { posts: true } } },
    });
    const stat = new Map<string, { threads: number; posts: number; last: { threadId: string; title: string; author: string; authorAvatar: string | null; at: Date } | null }>();
    for (const th of threads) {
      const s = stat.get(th.sectionId) ?? { threads: 0, posts: 0, last: null };
      s.threads += 1;
      s.posts += th._count.posts;
      if (!s.last) s.last = { threadId: th.id, title: th.title, author: handle(th.author), authorAvatar: th.author.avatarUrl, at: th.lastActivityAt }; // ordered desc -> first is newest
      stat.set(th.sectionId, s);
    }
    return sections.map((sec) => {
      const s = stat.get(sec.id);
      return {
        id: sec.id,
        group: sec.group,
        name: sec.name,
        description: sec.description,
        icon: sec.icon,
        threads: s?.threads ?? 0,
        messages: (s?.threads ?? 0) + (s?.posts ?? 0),
        lastPost: s?.last ?? null,
      };
    });
  }

  /** Latest active threads across all sections (sidebar). */
  async latest(limit = 12) {
    const threads = await this.prisma.forumThread.findMany({
      orderBy: { lastActivityAt: 'desc' },
      take: limit,
      include: {
        author: { select: { displayName: true, email: true, avatarUrl: true } },
        section: { select: { id: true, name: true, icon: true } },
        _count: { select: { posts: true } },
      },
    });
    return threads.map((th) => ({
      id: th.id,
      title: th.title,
      replies: th._count.posts,
      author: handle(th.author),
      authorAvatar: th.author.avatarUrl,
      lastActivityAt: th.lastActivityAt,
      section: th.section,
    }));
  }

  async listThreads(sectionId?: string) {
    const threads = await this.prisma.forumThread.findMany({
      where: sectionId ? { sectionId } : {},
      orderBy: [{ pinned: 'desc' }, { lastActivityAt: 'desc' }],
      take: 100,
      include: {
        author: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
        section: { select: { id: true, name: true, icon: true } },
        _count: { select: { posts: true } },
      },
    });
    return threads.map((t) => ({
      id: t.id,
      section: t.section,
      title: t.title,
      pinned: t.pinned,
      locked: t.locked,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
      author: { id: t.author.id, name: handle(t.author), avatarUrl: t.author.avatarUrl },
      replies: t._count.posts,
    }));
  }

  async createThread(userId: string, data: { sectionId: string; title: string; body: string }) {
    const section = await this.prisma.forumSection.findUnique({ where: { id: data.sectionId } });
    if (!section) throw new BadRequestException('unknown section');
    const t = await this.prisma.forumThread.create({
      data: { authorId: userId, sectionId: data.sectionId, title: data.title.trim(), body: data.body },
    });
    return { id: t.id };
  }

  async getThread(id: string) {
    const t = await this.prisma.forumThread.findUnique({
      where: { id },
      include: {
        author: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
        section: { select: { id: true, name: true, icon: true } },
        posts: {
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { id: true, displayName: true, email: true, avatarUrl: true } } },
        },
      },
    });
    if (!t) throw new NotFoundException('thread not found');
    return {
      id: t.id,
      section: t.section,
      title: t.title,
      body: t.body,
      pinned: t.pinned,
      locked: t.locked,
      createdAt: t.createdAt,
      author: { id: t.author.id, name: handle(t.author), avatarUrl: t.author.avatarUrl },
      posts: t.posts.map((p) => ({
        id: p.id,
        body: p.body,
        createdAt: p.createdAt,
        author: { id: p.author.id, name: handle(p.author), avatarUrl: p.author.avatarUrl },
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
