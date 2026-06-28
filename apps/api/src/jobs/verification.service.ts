import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, ComputeNode, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { TrustedExecutorService } from './verification/trusted-executor.service';
import {
  embeddingMatches,
  ewma,
  HIGH_VALUE_THRESHOLD,
  PROBATION_DEEP_PASSES,
  RETRO_AUDIT_WINDOW,
  SAMPLE_BASE,
  SAMPLE_FLOOR,
} from './verification/helpers';

export const JOB_REWARD: Record<string, number> = {
  'echo.v1': 1,
  'embedding.v1': 3,
};

interface WorkerOutput {
  success?: boolean;
  result?: Record<string, unknown>;
}

/**
 * G1 real compute verification. Security invariant: a node is paid IFF its result
 * is verified-correct against a TRUSTED reference; a proven-wrong result is slashed
 * (suspended, reward withheld/clawed back, requester refunded). Reputation moves
 * ONLY on deep-verified outcomes — never on the unsampled pass-by-trust path (C1).
 *
 * Full spec (red-team-folded): docs/architecture/verification-g1.md.
 * This slice is off-chain + synchronous; K-replica consensus and on-chain
 * staking/dispute are the next slices.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly executor: TrustedExecutorService,
    private readonly config: ConfigService,
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

  /** Probabilistic audit decision. PROBATION/SUSPENDED/high-value => always sampled. */
  private shouldSample(node: ComputeNode, reward: number): boolean {
    if (String(this.config.get('VERIFY_FORCE_SAMPLE') ?? 'false') === 'true') return true; // test hook
    if (node.lifecycleState === 'SUSPENDED' || node.lifecycleState === 'PROBATION') return true;
    if (reward >= HIGH_VALUE_THRESHOLD) return true;
    const base = SAMPLE_BASE * (1 - node.reputation);
    const floor = Math.max(SAMPLE_FLOOR, SAMPLE_FLOOR + node.unverifiedJobCount / 20_000);
    const rate = Math.max(floor, Math.min(SAMPLE_BASE, base));
    return Math.random() < rate;
  }

  /** Deep-compare the node's output to the trusted reference. */
  private deepCompare(jobType: string, output: WorkerOutput, ref: Record<string, unknown>): { ok: boolean; detail: Prisma.InputJsonValue } {
    const result = output?.result ?? {};
    if (jobType === 'echo.v1') {
      const ok = result.echo === ref.echo;
      return { ok, detail: { method: 'exact', ok } };
    }
    if (jobType === 'embedding.v1') {
      const out = result.vector as number[] | undefined;
      const r = ref.vector as number[] | undefined;
      if (!Array.isArray(out) || !Array.isArray(r)) return { ok: false, detail: { method: 'cosine', error: 'missing vector' } };
      const m = embeddingMatches(out, r);
      return { ok: m.ok, detail: { method: 'cosine', cos: m.cos, normRatio: m.normRatio, ok: m.ok } };
    }
    return { ok: false, detail: { error: 'no deep verifier' } };
  }

  private async record(
    jobId: string,
    jobType: string,
    sampled: boolean,
    method: 'SANITY_ONLY' | 'REEXEC',
    outcome: 'PASS' | 'FAIL' | 'PENDING',
    score: number | null,
    detail?: Prisma.InputJsonValue,
    provisional = false,
  ): Promise<void> {
    await this.prisma.jobVerification.upsert({
      where: { jobId },
      update: { outcome, sampled, method, score: score ?? undefined, resolvedAt: new Date(), detail, provisional },
      create: { jobId, jobType, sanityPassed: true, sampled, method, outcome, score: score ?? undefined, resolvedAt: new Date(), detail, provisional },
    });
  }

  private async grant(job: Job, node: ComputeNode, reward: number, optimistic: boolean): Promise<void> {
    if (reward <= 0) return;
    // node owner gets the reward minus the protocol take-rate (PROTOCOL_FEE_BPS)
    const net = await this.credits.rewardWithFee(node.ownerUserId, reward, 'NODE_REWARD', `reward:${job.id}`);
    if (optimistic) {
      // track outstanding (net) so a later deep-FAIL can claw back unspent cheated rewards
      await this.prisma.computeNode.update({ where: { id: node.id }, data: { outstandingOptimisticCredits: { increment: net } } });
      await this.prisma.job.update({ where: { id: job.id }, data: { grantedOptimistically: true } });
    }
  }

  private async finalize(jobId: string, reward: number, score: number, nrnEligible: boolean): Promise<void> {
    await this.prisma.job.update({
      where: { id: jobId },
      data: { status: 'REWARDED', verifiedAt: new Date(), rewardedAt: new Date(), verificationScore: score, rewardCredits: reward, nrnPayoutEligible: nrnEligible },
    });
    await this.prisma.jobEvent.create({ data: { jobId, type: 'rewarded', data: { reward, score, nrnEligible } } });
  }

  /** Deep-FAIL or sanity-FAIL slash: suspend node, withhold/claw back reward, refund user, drop reputation. */
  private async slash(job: Job, node: ComputeNode, reason: string, detail?: Prisma.InputJsonValue): Promise<void> {
    // claw back any optimistic reward still outstanding for this node's owner
    const clawback = Math.max(0, node.outstandingOptimisticCredits);
    if (clawback > 0) {
      const bal = await this.credits.getBalance(node.ownerUserId);
      const take = Math.min(bal, clawback);
      if (take > 0) await this.credits.spend(node.ownerUserId, take, 'NODE_REWARD_CLAWBACK', { idempotencyKey: `clawback:${job.id}` }).catch(() => undefined);
    }
    await this.prisma.computeNode.update({
      where: { id: node.id },
      data: {
        reputation: ewma(node.reputation, 0),
        lifecycleState: 'SUSPENDED',
        failedJobs: { increment: 1 },
        totalJobs: { increment: 1 },
        outstandingOptimisticCredits: 0,
      },
    });
    // owner-reputation keystone: one node's fraud drags all sibling nodes' sample rate up
    await this.prisma.ownerReputation
      .update({ where: { userId: node.ownerUserId }, data: { effectiveReputation: { decrement: 0.3 }, deepFailCount: { increment: 1 } } })
      .catch(() => undefined);
    if (job.costCredits > 0) {
      await this.credits.grant(job.userId, job.costCredits, 'USER_REFUND', `refund:${job.id}`).catch(() => undefined);
    }
    await this.prisma.job.update({ where: { id: job.id }, data: { status: 'FAILED', errorMessage: `verification failed: ${reason}` } });
    await this.prisma.jobEvent.create({ data: { jobId: job.id, type: 'verification.failed', message: reason, data: detail } });
    this.logger.warn(`job ${job.id} SLASHED node ${node.id} (${reason}) — suspended + clawback ${clawback} + user refund`);
    // Stake is forfeited (already spent at registration; never refunded for a fraudulent node).
    await this.retroAudit(node).catch((e) => this.logger.error(`retro-audit failed: ${(e as Error).message}`));
  }

  /** On a proven fraud, re-execute the node's recent UNSAMPLED (pass-by-trust) jobs
   * against the trusted reference and claw back any that don't match. */
  private async retroAudit(node: ComputeNode): Promise<void> {
    const jobs = await this.prisma.job.findMany({
      where: { nodeId: node.id, grantedOptimistically: true, status: { in: ['VERIFIED', 'REWARDED'] } },
      orderBy: { verifiedAt: 'desc' },
      take: RETRO_AUDIT_WINDOW,
    });
    let clawed = 0;
    let frauds = 0;
    for (const j of jobs) {
      const ref = await this.executor.reference(j.type, j.inputJson);
      if (ref === null) continue; // can't re-verify this type here
      const deep = this.deepCompare(j.type, (j.outputJson ?? {}) as WorkerOutput, ref);
      if (deep.ok) continue;
      frauds++;
      const reward = j.rewardCredits ?? 0;
      if (reward > 0) {
        const bal = await this.credits.getBalance(node.ownerUserId);
        const take = Math.min(bal, reward);
        if (take > 0) await this.credits.spend(node.ownerUserId, take, 'NODE_REWARD_CLAWBACK', { jobId: j.id, idempotencyKey: `clawback:${j.id}` }).catch(() => undefined);
        clawed += reward;
      }
      if (j.costCredits > 0) await this.credits.grant(j.userId, j.costCredits, 'USER_REFUND', `refund:${j.id}`).catch(() => undefined);
      await this.prisma.job.update({ where: { id: j.id }, data: { status: 'FAILED', errorMessage: 'retro-audit: re-exec mismatch' } }).catch(() => undefined);
      await this.prisma.jobVerification
        .upsert({
          where: { jobId: j.id },
          update: { outcome: 'FAIL', method: 'REEXEC', sampled: true, resolvedAt: new Date(), detail: { retroAudit: true, ...(deep.detail as object) } },
          create: { jobId: j.id, jobType: j.type, sanityPassed: true, sampled: true, method: 'REEXEC', outcome: 'FAIL', resolvedAt: new Date(), detail: { retroAudit: true } },
        })
        .catch(() => undefined);
    }
    if (frauds > 0) this.logger.warn(`retro-audit node ${node.id}: ${frauds} fraudulent prior job(s), ${clawed} credits clawed back`);
  }

  async handleCompleted(jobId: string, output: WorkerOutput): Promise<void> {
    // Atomic claim — exactly one caller transitions COMPLETED -> VERIFYING (closes the double-pay race).
    const claim = await this.prisma.job.updateMany({ where: { id: jobId, status: 'COMPLETED' }, data: { status: 'VERIFYING' } });
    if (claim.count !== 1) return;

    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || !job.nodeId) return;
    const node = await this.prisma.computeNode.findUnique({ where: { id: job.nodeId } });
    if (!node) return;
    const reward = JOB_REWARD[job.type] ?? 0;

    // L1 sanity (every job). A sanity fail is a MEASURED wrong result -> slash.
    const s = this.sanity(job, output);
    if (!s.ok) {
      await this.record(jobId, job.type, false, 'SANITY_ONLY', 'FAIL', 0, { reason: s.reason });
      await this.slash(job, node, s.reason ?? 'sanity', { stage: 'sanity' });
      return;
    }

    const sampled = this.shouldSample(node, reward);

    // Unsampled: optimistic grant. C1 — bump unverifiedJobCount but DO NOT touch reputation.
    if (!sampled) {
      await this.record(jobId, job.type, false, 'SANITY_ONLY', 'PASS', 1);
      await this.prisma.job.update({ where: { id: jobId }, data: { status: 'VERIFIED', verifiedAt: new Date(), verificationScore: 1 } });
      await this.grant(job, node, reward, true);
      await this.prisma.computeNode.update({
        where: { id: node.id },
        data: { unverifiedJobCount: { increment: 1 }, verifiedJobCount: { increment: 1 }, totalJobs: { increment: 1 }, successfulJobs: { increment: 1 }, lastVerifiedAt: new Date() },
      });
      await this.finalize(jobId, reward, 1, /*nrnEligible*/ false); // NRN is always strict — never optimistic
      return;
    }

    // Sampled: deep-verify against the trusted reference, reward WITHHELD until PASS.
    const ref = await this.executor.reference(job.type, job.inputJson);
    if (ref === null) {
      // can't deep-verify in this deployment (e.g. embedding disabled) -> provisional, no NRN
      await this.record(jobId, job.type, true, 'REEXEC', 'PENDING', 0.5, { note: 'trusted executor unavailable' }, true);
      await this.prisma.job.update({ where: { id: jobId }, data: { status: 'VERIFIED', verifiedAt: new Date(), verificationScore: 0.5 } });
      await this.grant(job, node, reward, true);
      await this.prisma.computeNode.update({ where: { id: node.id }, data: { unverifiedJobCount: { increment: 1 }, totalJobs: { increment: 1 }, successfulJobs: { increment: 1 } } });
      await this.finalize(jobId, reward, 0.5, false);
      return;
    }

    const deep = this.deepCompare(job.type, output, ref);
    await this.record(jobId, job.type, true, 'REEXEC', deep.ok ? 'PASS' : 'FAIL', deep.ok ? 1 : 0, deep.detail);

    if (!deep.ok) {
      await this.slash(job, node, 'deep re-exec mismatch', deep.detail);
      return;
    }

    // Deep PASS: pay (strict, NRN-eligible), raise reputation, graduate probation.
    const newRep = ewma(node.reputation, 1);
    const graduate = node.lifecycleState === 'PROBATION' && node.verifiedJobCount + 1 >= PROBATION_DEEP_PASSES;
    await this.prisma.job.update({ where: { id: jobId }, data: { status: 'VERIFIED', verifiedAt: new Date(), verificationScore: 1 } });
    await this.grant(job, node, reward, false);
    await this.prisma.computeNode.update({
      where: { id: node.id },
      data: {
        reputation: newRep,
        verifiedJobCount: { increment: 1 },
        totalJobs: { increment: 1 },
        successfulJobs: { increment: 1 },
        lastVerifiedAt: new Date(),
        ...(graduate ? { lifecycleState: 'ACTIVE' as const } : {}),
      },
    });
    // Graduation refunds the registration stake (the node proved honest over PROBATION).
    if (graduate && node.stakeCredits > 0 && !node.stakeRefunded) {
      await this.credits.grant(node.ownerUserId, node.stakeCredits, 'NODE_STAKE_REFUND', `stakerefund:${node.id}`).catch(() => undefined);
      await this.prisma.computeNode.update({ where: { id: node.id }, data: { stakeRefunded: true } }).catch(() => undefined);
    }
    await this.finalize(jobId, reward, 1, true);
  }
}
