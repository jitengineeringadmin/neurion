import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

interface PendingApproval {
  userId: string;
  runId: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  persisted: Promise<void>;
}

interface WaitApprovalInput {
  id: string;
  userId: string;
  runId: string;
  stepId?: string;
  toolName: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Human-in-the-loop approval gate. The agent loop awaits wait(id); a separate
 * HTTP call (POST /api/agent/approve) resolves it. Times out to denied.
 */
@Injectable()
export class AgentApprovalService {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly prisma: PrismaService) {}

  wait(input: WaitApprovalInput): Promise<boolean> {
    const timeoutMs = input.timeoutMs ?? 180_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(input.id);
        void persisted
          .then(() =>
            this.prisma.agentApproval.updateMany({
              where: { id: input.id, status: "PENDING" },
              data: { status: "EXPIRED", resolvedAt: new Date() },
            }),
          )
          .catch(() => undefined);
        resolve(false);
      }, timeoutMs);
      const persisted = this.prisma.agentApproval
        .create({
          data: {
            id: input.id,
            runId: input.runId,
            stepId: input.stepId,
            userId: input.userId,
            toolName: input.toolName,
            args: input.args
              ? (input.args as Prisma.InputJsonValue)
              : undefined,
            expiresAt: new Date(Date.now() + timeoutMs),
          },
        })
        .then(() => undefined);
      this.pending.set(input.id, {
        userId: input.userId,
        runId: input.runId,
        resolve,
        timer,
        persisted,
      });
      void persisted.catch(() => {
        const pending = this.pending.get(input.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(input.id);
        pending.resolve(false);
      });
    });
  }

  resolve(id: string, userId: string, approved: boolean): boolean {
    const p = this.pending.get(id);
    if (!p || p.userId !== userId) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    void p.persisted
      .then(() =>
        this.prisma.agentApproval.updateMany({
          where: { id, userId, status: "PENDING" },
          data: {
            status: approved ? "APPROVED" : "DENIED",
            resolvedAt: new Date(),
          },
        }),
      )
      .catch(() => undefined);
    p.resolve(approved);
    return true;
  }

  denyRun(runId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.runId === runId) this.resolve(id, pending.userId, false);
    }
  }
}
