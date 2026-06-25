import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentRequiredException } from './payment-required.exception';

@Injectable()
export class CreditsService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(userId: string): Promise<number> {
    const agg = await this.prisma.creditLedger.aggregate({
      where: { userId },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  async ledger(userId: string, take = 50) {
    return this.prisma.creditLedger.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * Spend `amount` (positive) from a user's balance. Append-only negative entry.
   * Throws 402 if balance is insufficient. Atomic via transaction.
   */
  async spend(
    userId: string,
    amount: number,
    reason: string,
    refs: { jobId?: string; chatMessageId?: string; idempotencyKey?: string } = {},
  ): Promise<number> {
    if (amount <= 0) return this.getBalance(userId);
    return this.prisma.$transaction(async (tx) => {
      const agg = await tx.creditLedger.aggregate({ where: { userId }, _sum: { amount: true } });
      const balance = agg._sum.amount ?? 0;
      if (balance < amount) {
        throw new PaymentRequiredException(`insufficient credits: have ${balance}, need ${amount}`);
      }
      const balanceAfter = balance - amount;
      await tx.creditLedger.create({
        data: {
          userId,
          reason,
          amount: -amount,
          balanceAfter,
          jobId: refs.jobId ?? null,
          chatMessageId: refs.chatMessageId ?? null,
          idempotencyKey: refs.idempotencyKey ?? null,
        } satisfies Prisma.CreditLedgerUncheckedCreateInput,
      });
      return balanceAfter;
    });
  }

  /** Grant credits (admin / reward). Positive entry. */
  async grant(userId: string, amount: number, reason: string, idempotencyKey?: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const agg = await tx.creditLedger.aggregate({ where: { userId }, _sum: { amount: true } });
      const balanceAfter = (agg._sum.amount ?? 0) + amount;
      await tx.creditLedger.create({
        data: { userId, reason, amount, balanceAfter, idempotencyKey: idempotencyKey ?? null },
      });
      return balanceAfter;
    });
  }
}
