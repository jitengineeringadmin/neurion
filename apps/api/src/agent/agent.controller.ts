import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { Response } from "express";
import { AgentApprovalService } from "./agent-approval.service";
import { AgentSettingsService } from "./agent-settings.service";
import { AgentRunService } from "./agent-run.service";
import { AgentSkillsService } from "./agent-skills.service";
import { AgentExecutionService } from "./agent-execution.service";
import {
  CurrentUser,
  AuthUser,
} from "../common/decorators/current-user.decorator";

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
  @IsIn(["ask", "auto", "local", "network"])
  computeMode?: "ask" | "auto" | "local" | "network";

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

  @IsOptional()
  @IsString()
  parentRunId?: string;
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

class SkillDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  triggers?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  body?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

@Controller("agent")
export class AgentController {
  constructor(
    private readonly executions: AgentExecutionService,
    private readonly approvals: AgentApprovalService,
    private readonly settings: AgentSettingsService,
    private readonly runs: AgentRunService,
    private readonly skills: AgentSkillsService,
  ) {}

  @Get("settings")
  getSettings(@CurrentUser() user: AuthUser) {
    return this.settings.get(user.sub);
  }

  @Put("settings")
  setSettings(@CurrentUser() user: AuthUser, @Body() dto: SettingsDto) {
    return this.settings.set(user.sub, dto.instructions ?? "");
  }

  @Get("skills")
  getSkills(@CurrentUser() user: AuthUser) {
    return { skills: this.skills.list(user.sub) };
  }

  @Post("skills")
  createSkill(@CurrentUser() user: AuthUser, @Body() dto: SkillDto) {
    return this.skills.create(user.sub, dto);
  }

  @Put("skills/:id")
  updateSkill(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() dto: SkillDto,
  ) {
    return this.skills.update(user.sub, id, dto);
  }

  @Delete("skills/:id")
  removeSkill(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.skills.remove(user.sub, id);
  }

  @Get("runs")
  listRuns(@CurrentUser() user: AuthUser) {
    return this.runs.list(user);
  }

  @Post("runs")
  startRun(@CurrentUser() user: AuthUser, @Body() dto: RunAgentDto) {
    return this.executions.start(user, dto);
  }

  @Get("runs/:id/events")
  runEvents(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("after") after?: string,
  ) {
    const cursor = Math.max(0, Number.parseInt(after ?? "0", 10) || 0);
    return this.runs.events(user, id, cursor).then((activity) => ({
      ...activity,
      active: this.executions.isActive(id),
    }));
  }

  @Get("runs/:id")
  runDetail(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.runs.detail(user, id);
  }

  @Get("artifacts/:id")
  artifact(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.runs.artifact(user, id);
  }

  @Post("runs/:id/cancel")
  async cancelRun(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.executions.cancel(user, id);
  }

  @Post("stream")
  async stream(
    @CurrentUser() user: AuthUser,
    @Body() dto: RunAgentDto,
    @Res() res: Response,
  ) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
    });

    const emit = (event: string, data: unknown): void => {
      if (clientGone || res.writableEnded) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        clientGone = true;
      }
    };

    try {
      const started = await this.executions.start(user, dto);
      let cursor = 0;
      while (!clientGone) {
        const activity = await this.runs.events(user, started.runId, cursor);
        for (const item of activity.events) emit(item.event, item.data);
        cursor = activity.cursor;
        const terminal = [
          "COMPLETED",
          "FAILED",
          "CANCELLED",
          "INTERRUPTED",
        ].includes(activity.run.status);
        if (terminal && !this.executions.isActive(started.runId)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (err) {
      emit("agent.error", { message: (err as Error).message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  @Post("approve")
  approve(@CurrentUser() user: AuthUser, @Body() dto: ApproveDto) {
    return { ok: this.approvals.resolve(dto.id, user.sub, dto.approved) };
  }
}
