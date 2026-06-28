import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { JobScheduler } from './job-scheduler.service';
import { AuthUser } from '../common/decorators/current-user.decorator';

const JOB_SPEND: Record<string, number> = {
  'echo.v1': 1,
  'embedding.v1': 5,
};
const ENABLED_TYPES = new Set(Object.keys(JOB_SPEND)); // G4: only MVP workers

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly scheduler: JobScheduler,
  ) {}

  async create(user: AuthUser, type: string, inputJson: Prisma.InputJsonValue, privacyLevel?: Prisma.JobCreateInput['privacyLevel']) {
    if (!ENABLED_TYPES.has(type)) {
      throw new BadRequestException(`job type "${type}" not available in this build`);
    }
    const cost = JOB_SPEND[type] ?? 0;
    // charge requester up-front (G10: settle on completion is future work)
    await this.credits.spend(user.sub, cost, `job.${type}`, { idempotencyKey: undefined });

    let job;
    try {
      job = await this.prisma.job.create({
        data: {
          workspaceId: user.workspaceId,
          userId: user.sub,
          type,
          lane: 'GRID',
          status: 'PENDING',
          privacyLevel: privacyLevel ?? 'PUBLIC',
          inputJson,
          costCredits: cost,
        },
      });
    } catch (e) {
      // creation failed after debiting — refund so credits are never silently lost
      if (cost > 0) await this.credits.grant(user.sub, cost, `job.${type}.refund`);
      throw e;
    }
    await this.prisma.jobEvent.create({ data: { jobId: job.id, type: 'created' } });
    await this.scheduler.tryAssign(job.id).catch(() => undefined); // best-effort; job stays PENDING otherwise
    return job;
  }

  async list(user: AuthUser) {
    return this.prisma.job.findMany({
      where: { userId: user.sub },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async get(user: AuthUser, id: string) {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('job not found');
    if (job.userId !== user.sub && job.workspaceId !== user.workspaceId) {
      throw new ForbiddenException('not your job');
    }
    return job;
  }

  async events(user: AuthUser, id: string) {
    await this.get(user, id);
    return this.prisma.jobEvent.findMany({ where: { jobId: id }, orderBy: { createdAt: 'asc' } });
  }

  async cancel(user: AuthUser, id: string) {
    const job = await this.get(user, id);
    if (['COMPLETED', 'VERIFIED', 'REWARDED'].includes(job.status)) {
      throw new BadRequestException('job already finished');
    }
    return this.prisma.job.update({ where: { id }, data: { status: 'CANCELLED' } });
  }
}
