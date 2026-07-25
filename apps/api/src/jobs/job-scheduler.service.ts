import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NodeGatewayService } from "../nodes/node-gateway.service";
import { VerificationService } from "./verification.service";
import { allowedTrustLevels } from "../ai/privacy/privacy.util";

const EU_REGIONS = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);
const ACTIVE_JOB_STATUSES = ["ASSIGNED", "ACCEPTED", "RUNNING"] as const;
const ASSIGN_LEASE_MS = 90_000;

const WORKER_IMAGE: Record<string, string> = {
  "echo.v1": "neurion/echo-worker:0.1.0",
  "embedding.v1": "neurion/embedding-worker:0.1.0",
  "image.v1": "neurion/image-worker:0.1.0",
};

/** Grid scheduler: assigns PENDING jobs to online nodes and drives the lifecycle
 *  from gateway events. In-process for MVP (BullMQ + the G11 EventBus are the
 *  horizontal-scale path). */
@Injectable()
export class JobScheduler implements OnModuleInit {
  private readonly logger = new Logger(JobScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NodeGatewayService,
    private readonly verification: VerificationService,
  ) {}

  onModuleInit(): void {
    this.gateway.on(
      "node.online",
      (e: { nodeId: string }) => void this.assignPendingToNode(e.nodeId),
    );
    this.gateway.on(
      "job.accepted",
      (e: { jobId: string; nodeId: string; attempt?: number }) =>
        void this.transition(
          e.jobId,
          e.nodeId,
          "ASSIGNED",
          "ACCEPTED",
          e.attempt,
        ),
    );
    this.gateway.on(
      "job.started",
      (e: { jobId: string; nodeId: string; attempt?: number }) =>
        void this.onStarted(e.jobId, e.nodeId, e.attempt),
    );
    this.gateway.on(
      "job.completed",
      (e: {
        jobId: string;
        nodeId: string;
        attempt?: number;
        outputJson?: unknown;
      }) => void this.onCompleted(e.jobId, e.nodeId, e.outputJson, e.attempt),
    );
    this.gateway.on(
      "job.failed",
      (e: {
        jobId: string;
        nodeId: string;
        attempt?: number;
        errorMessage?: string;
      }) => void this.onFailed(e.jobId, e.nodeId, e.errorMessage, e.attempt),
    );
    const timer = setInterval(() => void this.recoverExpiredLeases(), 30_000);
    timer.unref?.();
  }

  async tryAssign(jobId: string): Promise<boolean> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.status !== "PENDING") return false;

    const allowedTrust = [...allowedTrustLevels(job.privacyLevel)];
    const candidates = await this.prisma.computeNode.findMany({
      where: {
        id: { in: this.gateway.onlineNodeIds() },
        status: { notIn: ["DISABLED", "BANNED"] },
        lifecycleState: {
          in:
            job.privacyLevel === "PUBLIC"
              ? ["PROBATION", "ACTIVE"]
              : ["ACTIVE"],
        },
        trustLevel: { in: allowedTrust },
        supportedJobTypes: { has: job.type },
        ...(job.type === "image.v1" ? { nvidiaAvailable: true } : {}),
      },
      orderBy: { reputationScore: "desc" },
      take: 50,
    });
    const regional =
      job.privacyLevel === "EU_ONLY"
        ? candidates.filter(
            (candidate) =>
              candidate.regionCode &&
              EU_REGIONS.has(candidate.regionCode.toUpperCase()),
          )
        : candidates;
    const active = regional.length
      ? await this.prisma.job.groupBy({
          by: ["nodeId"],
          where: {
            nodeId: { in: regional.map((candidate) => candidate.id) },
            status: { in: [...ACTIVE_JOB_STATUSES] },
          },
          _count: { _all: true },
        })
      : [];
    const load = new Map(active.map((row) => [row.nodeId, row._count._all]));
    const node = regional.find(
      (candidate) =>
        (load.get(candidate.id) ?? 0) < candidate.maxConcurrentJobs,
    );
    if (!node) {
      this.logger.log(
        `no online node for job ${jobId} (${job.type}); staying PENDING`,
      );
      return false;
    }

    // Atomic claim: only one concurrent assign flips PENDING -> ASSIGNED, so a
    // job is never assigned (and dispatched) twice.
    const claim = await this.prisma.job.updateMany({
      where: { id: jobId, status: "PENDING" },
      data: {
        status: "ASSIGNED",
        nodeId: node.id,
        assignedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + ASSIGN_LEASE_MS),
        attempt: { increment: 1 },
      },
    });
    if (claim.count !== 1) return false;
    await this.prisma.jobEvent.create({
      data: { jobId, type: "assigned", data: { nodeId: node.id } },
    });

    const sent = this.gateway.send(node.id, {
      type: "job.assign",
      job: {
        id: job.id,
        type: job.type,
        inputJson: job.inputJson,
        containerImage: WORKER_IMAGE[job.type] ?? null,
        timeoutSec: 300,
        requiresGpu: job.type === "image.v1",
        attempt: job.attempt + 1,
      },
    });
    if (!sent) {
      await this.prisma.job.updateMany({
        where: { id: jobId, status: "ASSIGNED", nodeId: node.id },
        data: { status: "PENDING", nodeId: null, leaseExpiresAt: null },
      });
      return false;
    }
    this.logger.log(`job ${jobId} assigned to node ${node.id}`);
    return true;
  }

  private async assignPendingToNode(nodeId: string): Promise<void> {
    const node = await this.prisma.computeNode.findUnique({
      where: { id: nodeId },
    });
    if (!node) return;
    const pending = await this.prisma.job.findMany({
      where: { status: "PENDING", type: { in: node.supportedJobTypes } },
      orderBy: { createdAt: "asc" },
      take: 10,
    });
    for (const job of pending) await this.tryAssign(job.id);
  }

  private attemptWhere(attempt?: number): { attempt?: number } {
    return Number.isInteger(attempt) && Number(attempt) > 0 ? { attempt } : {};
  }

  private async transition(
    jobId: string,
    nodeId: string,
    from: string,
    to: string,
    attempt?: number,
  ): Promise<void> {
    const res = await this.prisma.job.updateMany({
      where: {
        id: jobId,
        nodeId,
        status: from as never,
        ...this.attemptWhere(attempt),
      },
      data: {
        status: to as never,
        leaseExpiresAt: new Date(Date.now() + ASSIGN_LEASE_MS),
      },
    });
    if (res.count > 0)
      await this.prisma.jobEvent.create({
        data: { jobId, type: to.toLowerCase() },
      });
  }

  private async onStarted(
    jobId: string,
    nodeId: string,
    attempt?: number,
  ): Promise<void> {
    const res = await this.prisma.job.updateMany({
      where: {
        id: jobId,
        nodeId,
        status: { in: ["ASSIGNED", "ACCEPTED"] },
        ...this.attemptWhere(attempt),
      },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    if (res.count > 0)
      await this.prisma.jobEvent.create({ data: { jobId, type: "running" } });
  }

  private async onCompleted(
    jobId: string,
    nodeId: string,
    outputJson: unknown,
    attempt?: number,
  ): Promise<void> {
    const res = await this.prisma.job.updateMany({
      where: {
        id: jobId,
        nodeId,
        status: { in: ["RUNNING", "ACCEPTED", "ASSIGNED"] },
        ...this.attemptWhere(attempt),
      },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        leaseExpiresAt: null,
        outputJson: (outputJson ?? {}) as never,
      },
    });
    if (res.count === 0) return;
    await this.prisma.jobEvent.create({ data: { jobId, type: "completed" } });
    await this.verification.handleCompleted(
      jobId,
      (outputJson ?? {}) as Record<string, unknown>,
    );
  }

  private async onFailed(
    jobId: string,
    nodeId: string,
    errorMessage?: string,
    attempt?: number,
  ): Promise<void> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, nodeId, ...this.attemptWhere(attempt) },
    });
    if (!job || ["VERIFIED", "REWARDED", "CANCELLED"].includes(job.status))
      return;
    const retry = job.attempt < job.maxAttempts;
    const res = await this.prisma.job.updateMany({
      where: {
        id: jobId,
        nodeId,
        status: { notIn: ["VERIFIED", "REWARDED", "CANCELLED"] },
      },
      data: {
        status: retry ? "PENDING" : "FAILED",
        nodeId: retry ? null : nodeId,
        leaseExpiresAt: null,
        errorMessage: errorMessage ?? "node reported failure",
      },
    });
    if (res.count > 0) {
      await this.prisma.jobEvent.create({
        data: {
          jobId,
          type: retry ? "retrying" : "failed",
          message: errorMessage,
          data: { attempt: job.attempt },
        },
      });
      if (retry) await this.tryAssign(jobId).catch(() => undefined);
    }
  }

  private async recoverExpiredLeases(): Promise<void> {
    const expired = await this.prisma.job.findMany({
      where: {
        status: { in: [...ACTIVE_JOB_STATUSES] },
        leaseExpiresAt: { lt: new Date() },
      },
      orderBy: { leaseExpiresAt: "asc" },
      take: 50,
    });
    for (const job of expired) {
      const retry = job.attempt < job.maxAttempts;
      const claimed = await this.prisma.job.updateMany({
        where: {
          id: job.id,
          status: job.status,
          leaseExpiresAt: job.leaseExpiresAt,
        },
        data: {
          status: retry ? "PENDING" : "FAILED",
          nodeId: retry ? null : job.nodeId,
          leaseExpiresAt: null,
          errorMessage: "node lease expired",
        },
      });
      if (claimed.count !== 1) continue;
      await this.prisma.jobEvent.create({
        data: {
          jobId: job.id,
          type: retry ? "lease.retry" : "lease.failed",
          data: { attempt: job.attempt },
        },
      });
      if (retry) await this.tryAssign(job.id).catch(() => undefined);
    }
  }
}
