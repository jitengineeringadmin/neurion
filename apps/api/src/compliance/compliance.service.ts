import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listRecords(take = 100) {
    return this.prisma.complianceRecord.findMany({ orderBy: { createdAt: 'desc' }, take });
  }

  async blockPayouts(adminUserId: string, userId: string, reason?: string) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { payoutHold: true } });
    const record = await this.prisma.complianceRecord.create({
      data: { userId, type: 'PAYOUT_BLOCK', status: 'OPEN', data: { reason: reason ?? null, by: adminUserId } },
    });
    await this.audit.log({
      action: 'compliance.payouts.blocked',
      actorUserId: adminUserId,
      entityType: 'User',
      entityId: userId,
      data: { reason: reason ?? null },
    });
    return { user: { id: user.id, payoutHold: user.payoutHold }, record };
  }

  async unblockPayouts(adminUserId: string, userId: string) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { payoutHold: false } });
    const record = await this.prisma.complianceRecord.create({
      data: { userId, type: 'PAYOUT_UNBLOCK', status: 'RESOLVED', data: { by: adminUserId } },
    });
    await this.audit.log({
      action: 'compliance.payouts.unblocked',
      actorUserId: adminUserId,
      entityType: 'User',
      entityId: userId,
    });
    return { user: { id: user.id, payoutHold: user.payoutHold }, record };
  }
}
