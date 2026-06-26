import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ChatConversation, JobPrivacyLevel, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChatMsg } from '../ai/providers/ai-provider.interface';
import { RoutePlan } from '../ai/ai-router.service';
import { AuthUser } from '../common/decorators/current-user.decorator';

const SYSTEM_PROMPT =
  'You are Neurion, a helpful assistant on a distributed AI compute network. Answer concisely.';

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  async createConversation(user: AuthUser, title?: string, privacyLevel?: JobPrivacyLevel) {
    return this.prisma.chatConversation.create({
      data: {
        workspaceId: user.workspaceId,
        userId: user.sub,
        title: title ?? null,
        privacyLevel: privacyLevel ?? 'VERIFIED_ONLY',
      },
    });
  }

  async listConversations(user: AuthUser) {
    return this.prisma.chatConversation.findMany({
      where: { userId: user.sub },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async updateConversation(user: AuthUser, id: string, data: { title?: string; pinned?: boolean; projectId?: string | null }) {
    await this.getConversation(user, id);
    return this.prisma.chatConversation.update({
      where: { id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.pinned !== undefined ? { pinned: data.pinned } : {}),
        ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
      },
    });
  }

  async removeConversation(user: AuthUser, id: string) {
    await this.getConversation(user, id);
    await this.prisma.$transaction([
      this.prisma.chatMessage.deleteMany({ where: { conversationId: id } }),
      this.prisma.chatConversation.delete({ where: { id } }),
    ]);
    return { ok: true };
  }

  async getConversation(user: AuthUser, id: string): Promise<ChatConversation> {
    const conv = await this.prisma.chatConversation.findUnique({ where: { id } });
    if (!conv) throw new NotFoundException('conversation not found');
    if (conv.userId !== user.sub) throw new ForbiddenException('not your conversation');
    return conv;
  }

  async listMessages(user: AuthUser, conversationId: string) {
    await this.getConversation(user, conversationId);
    return this.prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async ensureConversation(
    user: AuthUser,
    conversationId: string | undefined,
    firstMessage: string,
    privacyLevel?: JobPrivacyLevel,
  ): Promise<ChatConversation> {
    if (conversationId) return this.getConversation(user, conversationId);
    return this.createConversation(user, firstMessage.slice(0, 60), privacyLevel);
  }

  async addUserMessage(conversationId: string, content: string) {
    return this.prisma.chatMessage.create({
      data: { conversationId, role: 'USER', content },
    });
  }

  async buildContext(conversationId: string): Promise<ChatMsg[]> {
    const history = await this.prisma.chatMessage.findMany({
      where: { conversationId, role: { in: ['USER', 'ASSISTANT'] } },
      orderBy: { createdAt: 'asc' },
      take: 40,
    });
    const msgs: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }];
    for (const m of history) {
      msgs.push({ role: m.role === 'ASSISTANT' ? 'assistant' : 'user', content: m.content });
    }
    return msgs;
  }

  /** Persist assistant message + ChatMessageRoute (G2). Touches conversation updatedAt. */
  async addAssistantMessage(
    conversationId: string,
    content: string,
    plan: RoutePlan,
    costCredits: number,
    firstTokenMs: number | null,
  ) {
    const message = await this.prisma.chatMessage.create({
      data: {
        conversationId,
        role: 'ASSISTANT',
        content,
        laneUsed: plan.lane,
        modelUsed: plan.model,
        providerUsed: plan.provider.name,
        costCredits,
        routingDecision: {
          lane: plan.lane,
          provider: plan.provider.name,
          model: plan.model,
          effectivePrivacy: plan.effectivePrivacy,
          routeReason: plan.routeReason,
          servedTrustLevel: plan.servedTrustLevel,
          classifierCategory: plan.classification.category,
          firstTokenMs,
        } as Prisma.InputJsonValue,
      },
    });

    await this.prisma.chatMessageRoute.create({
      data: {
        messageId: message.id,
        effectivePrivacy: plan.effectivePrivacy,
        requestedPrivacy: plan.requestedPrivacy,
        routeReason: plan.routeReason,
        lane: plan.lane,
        servedTrustLevel: plan.servedTrustLevel,
        responseTrusted: plan.responseTrusted,
        escalated:
          plan.routeReason === 'CLASSIFIER_ESCALATED' ||
          plan.routeReason === 'SERVER_HARD_BLOCK' ||
          plan.routeReason === 'CLASSIFIER_FAILSAFE',
        classifierCategory: plan.classification.category,
      },
    });

    await this.prisma.chatConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    return message;
  }
}
