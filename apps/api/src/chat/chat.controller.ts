import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { Response } from 'express';
import { ChatService } from './chat.service';
import { AiRouterService, RoutePlan } from '../ai/ai-router.service';
import { CreditsService } from '../credits/credits.service';
import { MockProvider } from '../ai/providers/mock.provider';
import { CreateConversationDto, EstimateDto, StreamChatDto } from './dto/chat.dto';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

class PatchConversationDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  projectId?: string | null;
}

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chat: ChatService,
    private readonly router: AiRouterService,
    private readonly credits: CreditsService,
    private readonly config: ConfigService,
  ) {}

  @Post('conversations')
  createConversation(@CurrentUser() user: AuthUser, @Body() dto: CreateConversationDto) {
    return this.chat.createConversation(user, dto.title, dto.privacyLevel);
  }

  @Get('conversations')
  listConversations(@CurrentUser() user: AuthUser) {
    return this.chat.listConversations(user);
  }

  @Get('conversations/:id')
  getConversation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.chat.getConversation(user, id);
  }

  @Get('conversations/:id/messages')
  listMessages(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.chat.listMessages(user, id);
  }

  @Patch('conversations/:id')
  updateConversation(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PatchConversationDto) {
    return this.chat.updateConversation(user, id, dto);
  }

  @Delete('conversations/:id')
  removeConversation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.chat.removeConversation(user, id);
  }

  @Post('estimate')
  async estimate(@CurrentUser() user: AuthUser, @Body() dto: EstimateDto) {
    const plan = await this.router.plan({
      message: dto.message,
      conversationPrivacy: 'VERIFIED_ONLY',
      hasLiveOpenTierConsent: false,
      attachmentBytes: dto.attachmentBytes,
    });
    return {
      estimate: plan.estimate,
      lane: plan.lane,
      effectivePrivacy: plan.effectivePrivacy,
      routeReason: plan.routeReason,
      provider: plan.provider.name,
      model: plan.model,
      balance: await this.credits.getBalance(user.sub),
    };
  }

  @Post('stream')
  async stream(@CurrentUser() user: AuthUser, @Body() dto: StreamChatDto, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Backpressure: pause token production while the socket buffer is full so a
    // slow client can't make us buffer the whole stream in memory.
    const flush = (): Promise<void> =>
      res.writableNeedDrain ? new Promise<void>((r) => res.once('drain', r)) : Promise.resolve();

    try {
      const conv = await this.chat.ensureConversation(
        user,
        dto.conversationId,
        dto.message,
        dto.privacyLevel,
      );

      const plan = await this.router.plan({
        message: dto.message,
        conversationPrivacy: dto.privacyLevel ?? conv.privacyLevel,
        hasLiveOpenTierConsent: false,
        preferredModel: dto.preferredModel,
      });
      const cost = plan.estimate.estCredits;
      // user-chosen model overrides the default for real (non-mock) providers.
      const chosenModel = dto.preferredModel && plan.provider.name !== 'mock' ? dto.preferredModel : plan.model;

      // Soft-disabled online inference: when no real engine is reachable (mock
      // fallback) and this deploy runs without a server engine, return a clear
      // "use the app / run a node" notice instead of a fake mock answer — free.
      if (this.config.get<string>('AI_ONLINE_NO_ENGINE') === 'true' && plan.provider.name === 'mock') {
        await this.chat.addUserMessage(conv.id, dto.message);
        send('routing', {
          lane: 'FALLBACK',
          provider: 'none',
          model: null,
          labeled: false,
          effectivePrivacy: plan.effectivePrivacy,
          routeReason: 'NO_ONLINE_ENGINE',
          estCredits: 0,
        });
        const notice =
          "⚙ Online AI isn't running here. Neurion runs the model on YOUR machine — download the desktop app to chat locally and privately, or run a node to power the network. (Neurion fa girare il modello sul TUO computer: scarica l'app desktop o avvia un nodo.)";
        send('token', { text: notice });
        const assistant = await this.chat.addAssistantMessage(conv.id, notice, plan, 0, 0, null);
        send('final', {
          messageId: assistant.id,
          conversationId: conv.id,
          costCredits: 0,
          estCredits: 0,
          tokenUsage: null,
          firstTokenMs: 0,
          lane: 'FALLBACK',
          nodeReward: 0,
          balance: await this.credits.getBalance(user.sub),
        });
        return res.end();
      }

      const balance = await this.credits.getBalance(user.sub);
      if (balance < cost) {
        send('error', { message: 'insufficient credits', balance, cost });
        return res.end();
      }

      await this.chat.addUserMessage(conv.id, dto.message);

      send('routing', {
        lane: plan.lane,
        provider: plan.provider.name,
        model: chosenModel,
        labeled: plan.provider.labeled,
        effectivePrivacy: plan.effectivePrivacy,
        routeReason: plan.routeReason,
        estCredits: cost,
      });

      const context = await this.chat.buildContext(conv.id);
      let full = '';
      let firstTokenMs: number | null = null;
      let usedProvider = plan.provider;
      let usedModel = chosenModel;
      const t0 = Date.now();
      try {
        for await (const text of plan.provider.streamChat(context, chosenModel)) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
          full += text;
          send('token', { text });
          await flush();
        }
      } catch (streamErr) {
        // G3: real provider failed before producing output -> fall back to the
        // labeled mock so the user is never left stuck. Logged + re-routed.
        if (firstTokenMs !== null) throw streamErr;
        this.logger.warn(`provider ${plan.provider.name} failed, falling back to mock: ${(streamErr as Error).message}`);
        usedProvider = new MockProvider();
        usedModel = 'mock';
        send('routing', {
          lane: 'FALLBACK',
          provider: 'mock',
          labeled: true,
          note: `real provider unavailable: ${(streamErr as Error).message}`,
        });
        for await (const text of usedProvider.streamChat(context, usedModel)) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
          full += text;
          send('token', { text });
          await flush();
        }
      }

      // If the planned (FAST) node failed before any token, we fell back to the
      // mock provider — record the route honestly (FALLBACK/INTERNAL), not the
      // dead node, so the audit trail and reward reflect what actually served.
      const servedByNode = usedProvider === plan.provider;
      const effectivePlan: RoutePlan = servedByNode
        ? { ...plan, provider: usedProvider, model: usedModel }
        : { ...plan, provider: usedProvider, model: usedModel, lane: 'FALLBACK', servedTrustLevel: 'INTERNAL', responseTrusted: true, nodeId: undefined };
      const usage = usedProvider.getUsage?.() ?? null;
      const assistant = await this.chat.addAssistantMessage(conv.id, full, effectivePlan, cost, firstTokenMs, usage);
      await this.credits.spend(user.sub, cost, 'chat.fallback.small', { chatMessageId: assistant.id });

      // Cost reconciliation: when the provider reports real token usage, true-up
      // the up-front estimate (refund an overcharge; best-effort charge an undercharge).
      let finalCost = cost;
      if (usage && usage.totalTokens > 0) {
        const perCredit = Number(this.config.get<string>('AI_TOKENS_PER_CREDIT') ?? '1000') || 1000;
        const actual = Math.max(1, Math.ceil(usage.totalTokens / perCredit));
        const delta = actual - cost;
        if (delta > 0) {
          await this.credits.spend(user.sub, delta, 'chat.reconcile', { chatMessageId: assistant.id }).catch(() => undefined);
        } else if (delta < 0) {
          await this.credits.grant(user.sub, -delta, 'chat.reconcile.refund', `recon:${assistant.id}`);
        }
        finalCost = actual;
      }

      // Reward the serving node owner (earn NRN) only when the realtime node
      // actually produced the reply — never on the mock fallback.
      let nodeReward = 0;
      if (servedByNode) {
        nodeReward = await this.router
          .rewardRealtimeServe(plan, full.length, `realtime:${assistant.id}`)
          .catch(() => 0);
      }

      send('final', {
        messageId: assistant.id,
        conversationId: conv.id,
        costCredits: finalCost,
        estCredits: cost,
        tokenUsage: usage ?? undefined,
        firstTokenMs,
        lane: effectivePlan.lane,
        servedBy: servedByNode ? plan.nodeId : undefined,
        nodeReward,
        balance: await this.credits.getBalance(user.sub),
      });
      res.end();
    } catch (err) {
      send('error', { message: (err as Error).message });
      res.end();
    }
  }
}
