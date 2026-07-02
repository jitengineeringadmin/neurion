import { Body, Controller, Get, Post, Put, Res } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Response } from 'express';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { AgentApprovalService } from './agent-approval.service';
import { AgentSettingsService } from './agent-settings.service';
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

  // When true (+cwd set), confine all file tools to cwd — the Workspace page sets this
  // so the agent can only create/edit files inside the folder the user opened.
  @IsOptional()
  @IsBoolean()
  confineToCwd?: boolean;

  // Claude-Code "autonomous" mode: don't pause for per-action approval.
  @IsOptional()
  @IsBoolean()
  autoApprove?: boolean;
}

class ApproveDto {
  @IsString()
  id!: string;

  @IsBoolean()
  approved!: boolean;
}

class SettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  instructions?: string;
}

@Controller('agent')
export class AgentController {
  constructor(
    private readonly orchestrator: AgentOrchestratorService,
    private readonly approvals: AgentApprovalService,
    private readonly settings: AgentSettingsService,
  ) {}

  @Get('settings')
  getSettings() {
    return this.settings.get();
  }

  @Put('settings')
  setSettings(@Body() dto: SettingsDto) {
    return this.settings.set(dto.instructions ?? '');
  }

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
        confine: dto.confineToCwd,
        autoApprove: dto.autoApprove,
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
