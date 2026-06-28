import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { protocolFee } from '../jobs/verification/helpers';
import { PaymentRequiredException } from './payment-required.exception';

@Injectable()
export class CreditsService {
  private treasuryId: string | null | undefined; // undefined = not yet resolved

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private async treasuryUserId(): Promise<string | null> {
    if (this.treasuryId !== undefined) return this.treasuryId;
    const cfg = this.config.get<string>('PROTOCOL_TREASURY_USER_ID');
    if (cfg) return (this.treasuryId = cfg);
    const u = await this.prisma.user.findUnique({ where: { email: 'treasury@neurion.local' }, select: { id: true } });
    return (this.treasuryId = u?.id ?? null);
  }

  /**
   * Pay a node owner a gross reward minus an optional per-reward take-rate
   * (PROTOCOL_REWARD_FEE_BPS, default 0 — off, since at small reward sizes a %
   * floors to 0). The primary take-rate is collected at payout (collectFee).
   * Returns the NET credited to the node owner.
   */
  async rewardWithFee(ownerUserId: string, gross: number, reason: string, ref: string): Promise<number> {
    const bps = Number(this.config.get<string>('PROTOCOL_REWARD_FEE_BPS') ?? '0') || 0;
    let fee = protocolFee(gross, bps);
    const treasury = fee > 0 ? await this.treasuryUserId() : null;
    if (!treasury || treasury === ownerUserId) fee = 0;
    const net = gross - fee;
    if (net > 0) await this.grant(ownerUserId, net, reason, ref);
    if (fee > 0 && treasury) await this.grant(treasury, fee, 'PROTOCOL_FEE', `${ref}:fee`);
    return net;
  }

  /**
   * Collect the protocol take-rate (PROTOCOL_FEE_BPS) on a gross credit amount
   * being cashed out — credits the treasury, returns the fee. Used at payout
   * where amounts are large enough for the % to bite.
   */
  async collectFee(grossCredits: number, ref: string): Promise<number> {
    const bps = Number(this.config.get<string>('PROTOCOL_FEE_BPS') ?? '0') || 0;
    const fee = protocolFee(grossCredits, bps);
    if (fee <= 0) return 0;
    const treasury = await this.treasuryUserId();
    if (!treasury) return 0;
    await this.grant(treasury, fee, 'PROTOCOL_FEE', `fee:${ref}`);
    return fee;
  }

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
