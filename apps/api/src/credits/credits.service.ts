import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { PaymentRequiredException } from "./payment-required.exception";

@Injectable()
export class CreditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Credit a node owner for work they did. Once a take-rate minus a treasury;
   * now simply the whole amount, because there is no longer anything to take a
   * cut for. Kept as a named method rather than inlined: it is the one place
   * that says "this is what someone earned by helping", and phase 3 of the
   * peer-to-peer plan turns it into reciprocity rather than deleting it.
   */
  async reward(
    ownerUserId: string,
    amount: number,
    reason: string,
    ref: string,
  ): Promise<number> {
    if (amount > 0) await this.grant(ownerUserId, amount, reason, ref);
    return amount;
  }

  async getBalance(userId: string): Promise<number> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { creditBalance: true },
    });
    return u?.creditBalance ?? 0;
  }

  async ledger(userId: string, take = 50) {
    return this.prisma.creditLedger.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
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
    refs: {
      jobId?: string;
      chatMessageId?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<number> {
    if (amount <= 0) return this.getBalance(userId);
    // One PostgreSQL statement keeps the conditional debit and ledger append in
    // the same atomic operation without occupying an interactive transaction slot.
    const rows = await this.prisma.$queryRaw<
      Array<{ balanceAfter: number }>
    >(Prisma.sql`
      WITH updated AS (
        UPDATE "User"
        SET "creditBalance" = "creditBalance" - ${amount}, "updatedAt" = NOW()
        WHERE "id" = ${userId} AND "creditBalance" >= ${amount}
        RETURNING "creditBalance"
      ), inserted AS (
        INSERT INTO "CreditLedger" (
          "id", "userId", "reason", "amount", "balanceAfter",
          "jobId", "chatMessageId", "idempotencyKey", "createdAt"
        )
        SELECT
          ${randomUUID()}, ${userId}, ${reason}, ${-amount}, "creditBalance",
          ${refs.jobId ?? null}, ${refs.chatMessageId ?? null}, ${refs.idempotencyKey ?? null}, NOW()
        FROM updated
        RETURNING "balanceAfter"
      )
      SELECT "balanceAfter" FROM inserted
    `);
    const balanceAfter = rows[0]?.balanceAfter;
    if (balanceAfter === undefined) {
      const have = await this.getBalance(userId);
      throw new PaymentRequiredException(
        `insufficient credits: have ${have}, need ${amount}`,
      );
    }
    return balanceAfter;
  }

  /** Grant credits (admin / reward). Positive entry. Idempotent per key. */
  async grant(
    userId: string,
    amount: number,
    reason: string,
    idempotencyKey?: string,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: amount } },
        select: { creditBalance: true },
      });
      // If the idempotencyKey collides, this throws and rolls back the increment.
      await tx.creditLedger.create({
        data: {
          userId,
          reason,
          amount,
          balanceAfter: user.creditBalance,
          idempotencyKey: idempotencyKey ?? null,
        },
      });
      return user.creditBalance;
    });
  }
}
