import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { AgentApprovalService } from "./agent-approval.service";
import { AgentOrchestratorService } from "./agent-orchestrator.service";
import { AgentRunService } from "./agent-run.service";
import { AgentTerminalService } from "./agent-terminal.service";
import { ComputeMode, ToolCtx } from "./agent.types";
import { AuthUser } from "../common/decorators/current-user.decorator";

export interface StartAgentRunInput {
  goal: string;
  model?: string;
  cwd?: string;
  computeMode?: ComputeMode;
  networkModel?: string;
  relayBase?: string;
  relayToken?: string;
  confineToCwd?: boolean;
  autoApprove?: boolean;
  parentRunId?: string;
}

interface ActiveExecution {
  userId: string;
  controller: AbortController;
  eventWrites: Promise<void>;
  sequence: number;
}

const PERSISTED_EVENTS = new Set([
  "agent.run",
  "agent.start",
  "agent.compute",
  "agent.compute_request",
  "agent.compute_fallback",
  "agent.compute_billed",
  "agent.context_compacted",
  "agent.plan",
  "agent.plan_update",
  "agent.tool_call",
  "agent.tool_result",
  "agent.action_rejected",
  "agent.action_repaired",
  "agent.approval_request",
  "agent.approval_result",
  "agent.subagent.start",
  "agent.subagent.end",
  "agent.verification_required",
  "agent.verification_start",
  "agent.verification_result",
  "agent.review_start",
  "agent.review_result",
  "agent.process_status",
  "agent.final",
  "agent.done",
  "agent.cancelled",
  "agent.error",
]);

@Injectable()
export class AgentExecutionService {
  private readonly logger = new Logger(AgentExecutionService.name);
  private readonly active = new Map<string, ActiveExecution>();
  private readonly startingUsers = new Set<string>();

  constructor(
    private readonly orchestrator: AgentOrchestratorService,
    private readonly runs: AgentRunService,
    private readonly approvals: AgentApprovalService,
    private readonly terminal: AgentTerminalService,
  ) {}

  async start(user: AuthUser, input: StartAgentRunInput) {
    if (this.startingUsers.has(user.sub)) {
      throw new ConflictException("an agent run is already starting");
    }
    this.startingUsers.add(user.sub);
    try {
      const existing = await this.runs.active(user);
      if (existing) {
        return { runId: existing.id, status: existing.status, reused: true };
      }
      const baseCtx: ToolCtx = {
        user,
        emit: () => undefined,
        depth: 0,
        model: input.model,
        cwd: input.cwd,
        confine: input.confineToCwd,
        autoApprove: input.autoApprove,
        computeMode: input.computeMode,
        networkModel: input.networkModel,
        relayBase: input.relayBase,
        relayToken: input.relayToken,
        parentRunId: input.parentRunId,
      };
      const run = await this.orchestrator.createRun(input.goal, baseCtx);
      const execution: ActiveExecution = {
        userId: user.sub,
        controller: new AbortController(),
        eventWrites: Promise.resolve(),
        sequence: 0,
      };
      this.active.set(run.id, execution);
      setImmediate(() => void this.execute(run.id, input, baseCtx, execution));
      return { runId: run.id, status: run.status };
    } finally {
      this.startingUsers.delete(user.sub);
    }
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  async cancel(user: AuthUser, runId: string) {
    const run = await this.runs.cancel(user, runId);
    const execution = this.active.get(runId);
    if (execution?.userId === user.sub) execution.controller.abort();
    this.approvals.denyRun(runId);
    await this.terminal.stopRun(runId, user.sub);
    return run;
  }

  private async execute(
    runId: string,
    input: StartAgentRunInput,
    baseCtx: ToolCtx,
    execution: ActiveExecution,
  ): Promise<void> {
    const emit = (event: string, data: unknown): void => {
      if (!PERSISTED_EVENTS.has(event)) return;
      const sequence = ++execution.sequence;
      execution.eventWrites = execution.eventWrites
        .then(() => this.runs.appendEvent(runId, sequence, event, data))
        .catch((error) => {
          this.logger.warn(
            `Could not persist ${event} for run ${runId}: ${(error as Error).message}`,
          );
        });
    };
    const ctx: ToolCtx = {
      ...baseCtx,
      runId,
      emit,
      cancelSignal: execution.controller.signal,
    };

    emit("agent.start", {
      goal: input.goal,
      model: input.model ?? null,
      cwd: input.cwd ?? null,
    });
    try {
      const answer = await this.orchestrator.run(input.goal, ctx);
      emit("agent.done", { answer });
    } catch (error) {
      const cancelled =
        execution.controller.signal.aborted ||
        (await this.runs.isCancelled(runId));
      emit(cancelled ? "agent.cancelled" : "agent.error", {
        message: cancelled
          ? "Execution cancelled by user."
          : (error as Error).message,
      });
      if (!cancelled) {
        this.logger.error(
          `Agent run ${runId} failed: ${(error as Error).message}`,
        );
      }
    } finally {
      await execution.eventWrites;
      this.active.delete(runId);
    }
  }
}
