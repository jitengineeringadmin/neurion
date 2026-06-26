import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Res } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { Response } from 'express';
import { ChatService } from './chat.service';
import { AiRouterService } from '../ai/ai-router.service';
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
      });
      const cost = plan.estimate.estCredits;
      // user-chosen model overrides the default for real (non-mock) providers.
      const chosenModel = dto.preferredModel && plan.provider.name !== 'mock' ? dto.preferredModel : plan.model;

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
        }
      }

      const effectivePlan = { ...plan, provider: usedProvider, model: usedModel };
      const assistant = await this.chat.addAssistantMessage(conv.id, full, effectivePlan, cost, firstTokenMs);
      await this.credits.spend(user.sub, cost, 'chat.fallback.small', { chatMessageId: assistant.id });

      send('final', {
        messageId: assistant.id,
        conversationId: conv.id,
        costCredits: cost,
        firstTokenMs,
        lane: plan.lane,
        balance: balance - cost,
      });
      res.end();
    } catch (err) {
      send('error', { message: (err as Error).message });
      res.end();
    }
  }
}
