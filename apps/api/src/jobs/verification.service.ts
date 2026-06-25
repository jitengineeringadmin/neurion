import { Injectable, Logger } from '@nestjs/common';
import { Job } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';

export const JOB_REWARD: Record<string, number> = {
  'echo.v1': 1,
  'embedding.v1': 3,
};

interface WorkerOutput {
  success?: boolean;
  result?: Record<string, unknown>;
}

/**
 * G1 (MVP) — L1 sanity verification + reward release. Deep re-exec sampling is
 * designed in docs/architecture/verification-g1.md; this build runs sanity-only
 * and rewards on PASS. Reward goes to the NODE OWNER, post-VERIFIED.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
  ) {}

  private sanity(job: Job, output: WorkerOutput): { ok: boolean; reason?: string } {
    const result = output?.result ?? {};
    switch (job.type) {
      case 'echo.v1': {
        const input = (job.inputJson ?? {}) as { text?: string };
        return result.echo === input.text ? { ok: true } : { ok: false, reason: 'echo mismatch' };
      }
      case 'embedding.v1': {
        const v = result.vector as number[] | undefined;
        if (!Array.isArray(v) || v.length === 0) return { ok: false, reason: 'bad vector' };
        if (v.some((x) => !Number.isFinite(x))) return { ok: false, reason: 'NaN/Inf' };
        if (v.every((x) => x === 0)) return { ok: false, reason: 'zero vector' };
        return { ok: true };
      }
      default:
        return output?.success === true ? { ok: true } : { ok: false, reason: 'no success flag' };
    }
  }

  async handleCompleted(jobId: string, output: WorkerOutput): Promise<void> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || !job.nodeId) return;
    if (job.status === 'VERIFIED' || job.status === 'REWARDED') return; // idempotent

    const verdict = this.sanity(job, output);
    await this.prisma.jobVerification.upsert({
      where: { jobId },
      update: { outcome: verdict.ok ? 'PASS' : 'FAIL', resolvedAt: new Date() },
      create: {
        jobId,
        jobType: job.type,
        sanityPassed: verdict.ok,
        method: 'SANITY_ONLY',
        outcome: verdict.ok ? 'PASS' : 'FAIL',
        resolvedAt: new Date(),
        detail: verdict.reason ? { reason: verdict.reason } : undefined,
      },
    });

    if (!verdict.ok) {
      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: 'FAILED', errorMessage: `verification failed: ${verdict.reason}` },
      });
      await this.prisma.jobEvent.create({ data: { jobId, type: 'verification.failed', message: verdict.reason } });
      // refund the requester since the output is unusable
      if (job.costCredits > 0) {
        await this.credits.grant(job.userId, job.costCredits, 'USER_REFUND', `refund:${jobId}`);
      }
      return;
    }

    const node = await this.prisma.computeNode.findUnique({ where: { id: job.nodeId } });
    const reward = JOB_REWARD[job.type] ?? 0;

    await this.prisma.job.update({
      where: { id: jobId },
      data: { status: 'VERIFIED', verifiedAt: new Date(), verificationScore: 1, nrnPayoutEligible: true },
    });
    await this.prisma.jobEvent.create({ data: { jobId, type: 'verified' } });

    if (node && reward > 0) {
      await this.credits.grant(node.ownerUserId, reward, 'NODE_REWARD', `reward:${jobId}`);
      await this.prisma.computeNode.update({
        where: { id: node.id },
        data: {
          successfulJobs: { increment: 1 },
          totalJobs: { increment: 1 },
          verifiedJobCount: { increment: 1 },
          reputationScore: { increment: 1 },
          lastVerifiedAt: new Date(),
        },
      });
    }

    await this.prisma.job.update({
      where: { id: jobId },
      data: { status: 'REWARDED', rewardedAt: new Date(), rewardCredits: reward },
    });
    await this.prisma.jobEvent.create({ data: { jobId, type: 'rewarded', data: { reward } } });
    this.logger.log(`job ${jobId} VERIFIED + REWARDED (${reward} credits to node owner)`);
  }
}
