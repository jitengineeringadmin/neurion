import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NodeGatewayService } from '../nodes/node-gateway.service';
import { VerificationService } from './verification.service';

const WORKER_IMAGE: Record<string, string> = {
  'echo.v1': 'neurion/echo-worker:0.1.0',
  'embedding.v1': 'neurion/embedding-worker:0.1.0',
  'image.v1': 'neurion/image-worker:0.1.0',
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
    this.gateway.on('node.online', (e: { nodeId: string }) => void this.assignPendingToNode(e.nodeId));
    this.gateway.on('job.accepted', (e: { jobId: string }) => void this.transition(e.jobId, 'ASSIGNED', 'ACCEPTED'));
    this.gateway.on('job.started', (e: { jobId: string }) => void this.onStarted(e.jobId));
    this.gateway.on('job.completed', (e: { jobId: string; outputJson?: unknown }) => void this.onCompleted(e.jobId, e.outputJson));
    this.gateway.on('job.failed', (e: { jobId: string; errorMessage?: string }) => void this.onFailed(e.jobId, e.errorMessage));
  }

  async tryAssign(jobId: string): Promise<boolean> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'PENDING') return false;

    const candidates = await this.prisma.computeNode.findMany({
      where: {
        id: { in: this.gateway.onlineNodeIds() },
        status: { notIn: ['DISABLED', 'BANNED'] },
        supportedJobTypes: { has: job.type },
      },
      orderBy: { reputationScore: 'desc' },
    });
    const node = candidates[0];
    if (!node) {
      this.logger.log(`no online node for job ${jobId} (${job.type}); staying PENDING`);
      return false;
    }

    // Atomic claim: only one concurrent assign flips PENDING -> ASSIGNED, so a
    // job is never assigned (and dispatched) twice.
    const claim = await this.prisma.job.updateMany({
      where: { id: jobId, status: 'PENDING' },
      data: { status: 'ASSIGNED', nodeId: node.id, assignedAt: new Date() },
    });
    if (claim.count !== 1) return false;
    await this.prisma.jobEvent.create({ data: { jobId, type: 'assigned', data: { nodeId: node.id } } });

    const sent = this.gateway.send(node.id, {
      type: 'job.assign',
      job: {
        id: job.id,
        type: job.type,
        inputJson: job.inputJson,
        containerImage: WORKER_IMAGE[job.type] ?? null,
        timeoutSec: 300,
        requiresGpu: false,
      },
    });
    if (!sent) {
      await this.prisma.job.updateMany({ where: { id: jobId, status: 'ASSIGNED' }, data: { status: 'PENDING', nodeId: null } });
      return false;
    }
    this.logger.log(`job ${jobId} assigned to node ${node.id}`);
    return true;
  }

  private async assignPendingToNode(nodeId: string): Promise<void> {
    const node = await this.prisma.computeNode.findUnique({ where: { id: nodeId } });
    if (!node) return;
    const pending = await this.prisma.job.findMany({
      where: { status: 'PENDING', type: { in: node.supportedJobTypes } },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    for (const job of pending) await this.tryAssign(job.id);
  }

  private async transition(jobId: string, from: string, to: string): Promise<void> {
    const res = await this.prisma.job.updateMany({
      where: { id: jobId, status: from as never },
      data: { status: to as never },
    });
    if (res.count > 0) await this.prisma.jobEvent.create({ data: { jobId, type: to.toLowerCase() } });
  }

  private async onStarted(jobId: string): Promise<void> {
    const res = await this.prisma.job.updateMany({
      where: { id: jobId, status: { in: ['ASSIGNED', 'ACCEPTED'] } },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (res.count > 0) await this.prisma.jobEvent.create({ data: { jobId, type: 'running' } });
  }

  private async onCompleted(jobId: string, outputJson: unknown): Promise<void> {
    const res = await this.prisma.job.updateMany({
      where: { id: jobId, status: { in: ['RUNNING', 'ACCEPTED', 'ASSIGNED'] } },
      data: { status: 'COMPLETED', completedAt: new Date(), outputJson: (outputJson ?? {}) as never },
    });
    if (res.count === 0) return;
    await this.prisma.jobEvent.create({ data: { jobId, type: 'completed' } });
    await this.verification.handleCompleted(jobId, (outputJson ?? {}) as Record<string, unknown>);
  }

  private async onFailed(jobId: string, errorMessage?: string): Promise<void> {
    const res = await this.prisma.job.updateMany({
      where: { id: jobId, status: { notIn: ['VERIFIED', 'REWARDED', 'CANCELLED'] } },
      data: { status: 'FAILED', errorMessage: errorMessage ?? 'node reported failure' },
    });
    if (res.count > 0) await this.prisma.jobEvent.create({ data: { jobId, type: 'failed', message: errorMessage } });
  }
}
