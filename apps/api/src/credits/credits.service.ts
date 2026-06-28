import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentRequiredException } from './payment-required.exception';

@Injectable()
export class CreditsService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(userId: string): Promise<number> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { creditBalance: true } });
    return u?.creditBalance ?? 0;
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
      // Atomic conditional decrement: the WHERE re-evaluates under the row lock,
      // so two concurrent spends can't both pass when only one can afford it.
      const dec = await tx.user.updateMany({
        where: { id: userId, creditBalance: { gte: amount } },
        data: { creditBalance: { decrement: amount } },
      });
      if (dec.count !== 1) {
        const have = (await tx.user.findUnique({ where: { id: userId }, select: { creditBalance: true } }))?.creditBalance ?? 0;
        throw new PaymentRequiredException(`insufficient credits: have ${have}, need ${amount}`);
      }
      const balanceAfter = (await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { creditBalance: true } })).creditBalance;
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

  /** Grant credits (admin / reward). Positive entry. Idempotent per key. */
  async grant(userId: string, amount: number, reason: string, idempotencyKey?: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: amount } },
        select: { creditBalance: true },
      });
      // If the idempotencyKey collides, this throws and rolls back the increment.
      await tx.creditLedger.create({
        data: { userId, reason, amount, balanceAfter: user.creditBalance, idempotencyKey: idempotencyKey ?? null },
      });
      return user.creditBalance;
    });
  }
}
