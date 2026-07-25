import { Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AgentStepKind, AgentStepStatus, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { AuthUser } from "../common/decorators/current-user.decorator";
import { PrismaService } from "../prisma/prisma.service";

export interface CreateAgentRunInput {
  goal: string;
  computeMode?: string;
  model?: string;
  cwd?: string;
  parentRunId?: string;
  contextTokenLimit?: number;
}

@Injectable()
export class AgentRunService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.interruptOrphanedRuns();
    await this.interruptStaleRuns();
    const timer = setInterval(() => void this.interruptStaleRuns(), 60_000);
    timer.unref?.();
  }

  private async interruptOrphanedRuns(): Promise<void> {
    const active = ["PENDING", "RUNNING", "WAITING_APPROVAL"] as const;
    await this.prisma.$transaction([
      this.prisma.agentStep.updateMany({
        where: {
          status: { in: ["RUNNING", "WAITING_APPROVAL"] },
          run: { status: { in: [...active] } },
        },
        data: { status: "CANCELLED", completedAt: new Date() },
      }),
      this.prisma.agentApproval.updateMany({
        where: {
          status: "PENDING",
          run: { status: { in: [...active] } },
        },
        data: { status: "EXPIRED", resolvedAt: new Date() },
      }),
      this.prisma.agentRun.updateMany({
        where: { status: { in: [...active] } },
        data: {
          status: "INTERRUPTED",
          errorMessage: "Execution interrupted because the backend restarted.",
          completedAt: new Date(),
          lastHeartbeatAt: new Date(),
        },
      }),
    ]);
  }

  private async interruptStaleRuns(): Promise<void> {
    const staleMinutes = Math.max(
      2,
      Number(this.config.get("AGENT_STALE_RUN_MINUTES") ?? 5),
    );
    const cutoff = new Date(Date.now() - staleMinutes * 60_000);
    await this.prisma.agentRun.updateMany({
      where: {
        status: { in: ["RUNNING", "WAITING_APPROVAL"] },
        lastHeartbeatAt: { lt: cutoff },
      },
      data: {
        status: "INTERRUPTED",
        errorMessage: "Execution interrupted before completion.",
      },
    });
    await this.prisma.agentApproval.updateMany({
      where: { status: "PENDING", run: { status: "INTERRUPTED" } },
      data: { status: "EXPIRED", resolvedAt: new Date() },
    });
  }

  async create(user: AuthUser, input: CreateAgentRunInput) {
    if (input.parentRunId) {
      const parent = await this.prisma.agentRun.findFirst({
        where: { id: input.parentRunId, userId: user.sub },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException("parent agent run not found");
    }
    return this.prisma.agentRun.create({
      data: {
        workspaceId: user.workspaceId,
        userId: user.sub,
        parentRunId: input.parentRunId,
        goal: input.goal,
        computeMode: input.computeMode ?? "ask",
        requestedModel: input.model,
        cwd: input.cwd,
        contextTokenLimit: input.contextTokenLimit ?? 8192,
      },
    });
  }

  async start(runId: string, resolvedModel?: string): Promise<void> {
    await this.prisma.agentRun.updateMany({
      where: { id: runId, status: "PENDING" },
      data: {
        status: "RUNNING",
        resolvedModel,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        errorMessage: null,
      },
    });
  }

  async heartbeat(runId: string, resolvedModel?: string): Promise<void> {
    await this.prisma.agentRun.updateMany({
      where: { id: runId, status: { in: ["RUNNING", "WAITING_APPROVAL"] } },
      data: {
        lastHeartbeatAt: new Date(),
        ...(resolvedModel ? { resolvedModel } : {}),
      },
    });
  }

  async appendStep(
    runId: string,
    input: {
      depth: number;
      kind: AgentStepKind;
      status?: AgentStepStatus;
      toolName?: string;
      thought?: string;
      args?: Record<string, unknown>;
      resultPreview?: string;
      tokenEstimate?: number;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.agentRun.update({
        where: { id: runId },
        data: { currentStep: { increment: 1 }, lastHeartbeatAt: new Date() },
        select: { currentStep: true },
      });
      return tx.agentStep.create({
        data: {
          runId,
          sequence: run.currentStep,
          depth: input.depth,
          kind: input.kind,
          status: input.status ?? "RUNNING",
          toolName: input.toolName,
          thought: input.thought,
          args: input.args ? (input.args as Prisma.InputJsonValue) : undefined,
          resultPreview: input.resultPreview,
          tokenEstimate: input.tokenEstimate,
          completedAt: input.status === "COMPLETED" ? new Date() : undefined,
        },
      });
    });
  }

  async finishStep(
    stepId: string,
    status: AgentStepStatus,
    resultPreview?: string,
  ): Promise<void> {
    const terminal = ["COMPLETED", "FAILED", "DENIED", "CANCELLED"].includes(
      status,
    );
    await this.prisma.agentStep.update({
      where: { id: stepId },
      data: {
        status,
        resultPreview,
        completedAt: terminal ? new Date() : null,
      },
    });
  }

  async saveArtifact(
    runId: string,
    stepId: string | undefined,
    kind: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) {
    const originalBytes = Buffer.byteLength(content, "utf8");
    const cap = Math.max(
      64_000,
      Number(this.config.get("AGENT_ARTIFACT_MAX_BYTES") ?? 1_000_000),
    );
    const stored = originalBytes > cap ? content.slice(0, cap) : content;
    return this.prisma.agentArtifact.create({
      data: {
        runId,
        stepId,
        kind,
        content: stored,
        sha256: createHash("sha256").update(content).digest("hex"),
        sizeBytes: originalBytes,
        metadata: {
          ...(metadata ?? {}),
          truncated: originalBytes > cap,
          storedBytes: Buffer.byteLength(stored, "utf8"),
        } as Prisma.InputJsonValue,
      },
    });
  }

  async waitForApproval(runId: string): Promise<void> {
    await this.prisma.agentRun.updateMany({
      where: { id: runId, status: "RUNNING" },
      data: { status: "WAITING_APPROVAL", lastHeartbeatAt: new Date() },
    });
  }

  async resumeAfterApproval(runId: string): Promise<void> {
    await this.prisma.agentRun.updateMany({
      where: { id: runId, status: "WAITING_APPROVAL" },
      data: { status: "RUNNING", lastHeartbeatAt: new Date() },
    });
  }

  async complete(runId: string, answer: string): Promise<void> {
    await this.prisma.agentRun.updateMany({
      where: { id: runId, status: { notIn: ["CANCELLED", "COMPLETED"] } },
      data: {
        status: "COMPLETED",
        finalAnswer: answer,
        completedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });
  }

  async fail(runId: string, error: string): Promise<void> {
    await this.prisma.agentRun.updateMany({
      where: { id: runId, status: { notIn: ["CANCELLED", "COMPLETED"] } },
      data: {
        status: "FAILED",
        errorMessage: error.slice(0, 4000),
        completedAt: new Date(),
      },
    });
  }

  async isCancelled(runId: string): Promise<boolean> {
    const run = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    return !run || run.status === "CANCELLED";
  }

  async cancel(user: AuthUser, runId: string) {
    const run = await this.getOwned(user, runId);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) return run;
    const [cancelled] = await this.prisma.$transaction([
      this.prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
          lastHeartbeatAt: new Date(),
          errorMessage: "Cancelled by user.",
        },
      }),
      this.prisma.agentStep.updateMany({
        where: {
          runId,
          status: { in: ["RUNNING", "WAITING_APPROVAL"] },
        },
        data: { status: "CANCELLED", completedAt: new Date() },
      }),
      this.prisma.agentApproval.updateMany({
        where: { runId, status: "PENDING" },
        data: { status: "EXPIRED", resolvedAt: new Date() },
      }),
    ]);
    return cancelled;
  }

  active(user: AuthUser) {
    return this.prisma.agentRun.findFirst({
      where: {
        userId: user.sub,
        status: { in: ["PENDING", "RUNNING", "WAITING_APPROVAL"] },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async appendEvent(
    runId: string,
    sequence: number,
    event: string,
    data: unknown,
  ): Promise<void> {
    const raw = JSON.stringify({ sequence, event, data });
    const maxBytes = 200_000;
    const content =
      Buffer.byteLength(raw, "utf8") <= maxBytes
        ? raw
        : JSON.stringify({
            sequence,
            event,
            data: {
              truncated: true,
              preview: raw.slice(0, maxBytes),
            },
          });
    await this.saveArtifact(runId, undefined, "agent-event", content, {
      sequence,
      event,
    });
  }

  async events(user: AuthUser, runId: string, after = 0) {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: runId, userId: user.sub },
      select: {
        id: true,
        goal: true,
        status: true,
        computeMode: true,
        requestedModel: true,
        resolvedModel: true,
        cwd: true,
        currentStep: true,
        finalAnswer: true,
        errorMessage: true,
        lastHeartbeatAt: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        approvals: {
          where: { status: "PENDING" },
          orderBy: { createdAt: "asc" },
          select: { id: true, status: true, toolName: true, args: true },
        },
      },
    });
    if (!run) throw new NotFoundException("agent run not found");
    const artifacts = await this.prisma.agentArtifact.findMany({
      where: { runId, kind: "agent-event" },
      orderBy: { createdAt: "asc" },
      take: 1000,
      select: { id: true, content: true, createdAt: true },
    });
    const events = artifacts
      .map((artifact) => {
        try {
          const parsed = JSON.parse(artifact.content) as {
            sequence?: number;
            event?: string;
            data?: unknown;
          };
          if (
            !Number.isInteger(parsed.sequence) ||
            typeof parsed.event !== "string"
          ) {
            return null;
          }
          return {
            id: artifact.id,
            sequence: parsed.sequence as number,
            event: parsed.event,
            data: parsed.data,
            createdAt: artifact.createdAt,
          };
        } catch {
          return null;
        }
      })
      .filter(
        (event): event is NonNullable<typeof event> =>
          event !== null && event.sequence > after,
      );
    return {
      run,
      events,
      cursor: events.reduce(
        (max, event) => Math.max(max, event.sequence),
        after,
      ),
    };
  }

  async resumeContext(user: AuthUser, runId: string): Promise<string> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: runId, userId: user.sub },
      include: {
        steps: {
          where: { status: { in: ["COMPLETED", "FAILED", "DENIED"] } },
          orderBy: { sequence: "desc" },
          take: 24,
        },
      },
    });
    if (!run) throw new NotFoundException("parent agent run not found");
    const history = [...run.steps]
      .reverse()
      .map((step) => {
        const label = step.toolName
          ? `${step.kind}:${step.toolName}`
          : step.kind;
        const result = step.resultPreview?.slice(0, 1200) ?? "";
        return `- ${label} [${step.status}]${result ? `: ${result}` : ""}`;
      })
      .join("\n");
    return [
      "A previous execution of this goal was interrupted.",
      `Previous status: ${run.status}. Completed steps: ${run.currentStep}.`,
      "The workspace already contains any successful changes. Inspect current files before editing, do not blindly repeat mutations, then continue from the remaining work.",
      history ? `Previous durable activity:\n${history}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  list(user: AuthUser) {
    return this.prisma.agentRun.findMany({
      where: { userId: user.sub },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        goal: true,
        status: true,
        computeMode: true,
        requestedModel: true,
        resolvedModel: true,
        cwd: true,
        finalAnswer: true,
        errorMessage: true,
        currentStep: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
      },
    });
  }

  async getOwned(user: AuthUser, runId: string) {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: runId, userId: user.sub },
    });
    if (!run) throw new NotFoundException("agent run not found");
    return run;
  }

  async detail(user: AuthUser, runId: string) {
    await this.getOwned(user, runId);
    return this.prisma.agentRun.findUnique({
      where: { id: runId },
      include: {
        steps: { orderBy: { sequence: "asc" } },
        approvals: { orderBy: { createdAt: "asc" } },
        artifacts: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            stepId: true,
            kind: true,
            mime: true,
            sha256: true,
            sizeBytes: true,
            metadata: true,
            createdAt: true,
          },
        },
      },
    });
  }

  async artifact(user: AuthUser, artifactId: string) {
    const artifact = await this.prisma.agentArtifact.findFirst({
      where: { id: artifactId, run: { userId: user.sub } },
    });
    if (!artifact) throw new NotFoundException("agent artifact not found");
    return artifact;
  }

  async findPatchCheckpoint(runId: string, patchId: string) {
    const artifacts = await this.prisma.agentArtifact.findMany({
      where: { runId, kind: "patch-checkpoint" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return (
      artifacts.find((artifact) => {
        const metadata = artifact.metadata as Record<string, unknown> | null;
        return metadata?.patchId === patchId;
      }) ?? null
    );
  }

  patchArtifacts(runId: string) {
    return this.prisma.agentArtifact.findMany({
      where: {
        runId,
        kind: { in: ["patch-checkpoint", "patch-rollback"] },
      },
      orderBy: { createdAt: "asc" },
      select: { kind: true, content: true, createdAt: true },
    });
  }
}
