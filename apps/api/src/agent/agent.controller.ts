import { Body, Controller, Post, Res } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Response } from 'express';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { AgentApprovalService } from './agent-approval.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

class RunAgentDto {
  @IsString()
  @MaxLength(4000)
  goal!: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  cwd?: string;

  @IsOptional()
  @IsIn(['ask', 'auto', 'local', 'network'])
  computeMode?: 'ask' | 'auto' | 'local' | 'network';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  networkModel?: string;

  // Desktop relay: the remote API base + a token for it, so the local agent can use
  // the remote shared node pool for the network LLM step.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  relayBase?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  relayToken?: string;
}

class ApproveDto {
  @IsString()
  id!: string;

  @IsBoolean()
  approved!: boolean;
}

@Controller('agent')
export class AgentController {
  constructor(
    private readonly orchestrator: AgentOrchestratorService,
    private readonly approvals: AgentApprovalService,
  ) {}

  @Post('stream')
  async stream(@CurrentUser() user: AuthUser, @Body() dto: RunAgentDto, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const emit = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      emit('agent.start', { goal: dto.goal, model: dto.model ?? null, cwd: dto.cwd ?? null });
      const answer = await this.orchestrator.run(dto.goal, {
        user,
        emit,
        depth: 0,
        model: dto.model,
        cwd: dto.cwd,
        computeMode: dto.computeMode,
        networkModel: dto.networkModel,
        relayBase: dto.relayBase,
        relayToken: dto.relayToken,
      });
      emit('agent.done', { answer });
    } catch (err) {
      emit('agent.error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  }

  @Post('approve')
  approve(@CurrentUser() _user: AuthUser, @Body() dto: ApproveDto) {
    return { ok: this.approvals.resolve(dto.id, dto.approved) };
  }
}
