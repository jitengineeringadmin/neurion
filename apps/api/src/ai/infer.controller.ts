import { Body, Controller, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { JobPrivacyLevel } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Response } from 'express';
import { RealtimePoolService } from './realtime-pool.service';
import { CreditsService } from '../credits/credits.service';
import { ChatMsg } from './providers/ai-provider.interface';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

class InferDto {
  @IsArray()
  messages!: ChatMsg[];

  @IsString()
  @MaxLength(200)
  model!: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

/**
 * Stateless inference primitive: run one completion on a warm realtime node and
 * stream the tokens back, billing the caller + rewarding the node. Unlike chat,
 * it persists nothing — this is what a DESKTOP node-relay calls so a local agent
 * loop (which must stay local to touch the user's files) can use this network's
 * shared node pool for the heavy LLM step. See [[neurion-compute-control]].
 */
@Controller('ai')
export class InferController {
  constructor(
    private readonly pool: RealtimePoolService,
    private readonly credits: CreditsService,
    private readonly config: ConfigService,
  ) {}

  @Post('infer')
  async infer(@CurrentUser() user: AuthUser, @Body() dto: InferDto, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const w = await this.pool.findWarm(dto.model, 'PUBLIC' as JobPrivacyLevel).catch(() => null);
    if (!w) {
      emit('error', { message: `no online node serving ${dto.model}` });
      return void res.end();
    }
    emit('node', { nodeId: w.nodeId, model: w.model });

    let chars = 0;
    try {
      for await (const tok of w.provider.streamChat(dto.messages, w.model)) {
        chars += tok.length;
        emit('token', { t: tok });
      }
    } catch (e) {
      emit('error', { message: (e as Error).message });
      return void res.end();
    }

    // Bill the caller + reward the node (mirrors the agent's meterNetwork).
    const ref = dto.idempotencyKey || `relay:${user.sub}:${randomUUID()}`;
    const estTokens = Math.ceil(chars / 4);
    const ratePer1k = Number(this.config.get<string>('AI_REALTIME_REWARD_PER_1K_TOKENS') ?? '1') || 1;
    const cost = Math.max(1, Math.round((estTokens / 1000) * ratePer1k));
    await this.credits.spend(user.sub, cost, 'RELAY_INFER', { idempotencyKey: ref }).catch(() => undefined);
    await this.pool.rewardServe(w.nodeId, chars, ref).catch(() => undefined);
    emit('done', { nodeId: w.nodeId, model: w.model, credits: cost, chars });
    res.end();
  }
}
