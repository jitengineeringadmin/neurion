import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ethers } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { AuditService } from '../audit/audit.service';
import { TokenConfigService } from './token-config.service';
import { EmissionService } from './emission.service';
import { AuthUser } from '../common/decorators/current-user.decorator';

@Injectable()
export class TokenPayoutService {
  private readonly logger = new Logger(TokenPayoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly config: TokenConfigService,
    private readonly audit: AuditService,
    private readonly emission: EmissionService,
  ) {}

  private creditsToWei(credits: number): bigint {
    return BigInt(credits) * BigInt(this.config.creditToNrnWei);
  }
  private weiToCredits(wei: string): number {
    return Number(BigInt(wei) / BigInt(this.config.creditToNrnWei));
  }

  async requestPayout(user: AuthUser, credits: number) {
    if (credits <= 0) throw new BadRequestException('credits must be positive');
    if (!this.config.payoutsEnabled) throw new ForbiddenException('token payouts are disabled');

    const dbUser = await this.prisma.user.findUniqueOrThrow({ where: { id: user.sub } });
    if (!dbUser.walletAddress) throw new BadRequestException('link a wallet first');
    if (dbUser.payoutHold || dbUser.kycStatus === 'PAYOUT_BLOCKED' || dbUser.kycStatus === 'KYC_REJECTED') {
      throw new ForbiddenException('payouts blocked for this account');
    }
    const threshold = Number(process.env.KYC_PAYOUT_THRESHOLD_CREDITS ?? 1000);
    if (credits >= threshold && dbUser.kycStatus !== 'KYC_APPROVED') {
      throw new ForbiddenException(`KYC required for payouts >= ${threshold} credits`);
    }

    // convert: spend the credits now (refunded if the on-chain tx fails)
    await this.credits.spend(user.sub, credits, 'payout.request');

    const payout = await this.prisma.tokenPayout.create({
      data: {
        userId: user.sub,
        walletAddress: dbUser.walletAddress,
        amountWei: this.creditsToWei(credits).toString(),
        chainId: this.config.chainId,
        status: 'PENDING',
      },
    });
    await this.audit.log({
      action: 'token.payout.requested',
      actorUserId: user.sub,
      entityType: 'TokenPayout',
      entityId: payout.id,
      data: { credits },
    });
    return payout;
  }

  async listPayouts(user: AuthUser) {
    return this.prisma.tokenPayout.findMany({ where: { userId: user.sub }, orderBy: { createdAt: 'desc' } });
  }

  async getPayout(user: AuthUser, id: string) {
    const p = await this.prisma.tokenPayout.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('payout not found');
    if (p.userId !== user.sub) throw new ForbiddenException('not your payout');
    return p;
  }

  /** Admin: submit all PENDING payouts on-chain via the ComputeRewardVault. */
  async processPayouts(adminUserId: string) {
    if (!this.config.payoutsEnabled) throw new ForbiddenException('token payouts are disabled');
    const candidates = await this.prisma.tokenPayout.findMany({ where: { status: 'PENDING' }, take: 50, select: { id: true } });
    const vault = this.config.signerVault();
    const results: Array<{ id: string; status: string; txHash?: string; error?: string }> = [];

    for (const { id } of candidates) {
      // Atomic claim: only one concurrent run flips PENDING -> PROCESSING, so a
      // payout is never submitted (and refunded) twice.
      const claim = await this.prisma.tokenPayout.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'PROCESSING' } });
      if (claim.count !== 1) continue;
      const payout = await this.prisma.tokenPayout.findUniqueOrThrow({ where: { id } });

      // G12: reserve emission before paying; defer if it would exceed the cap.
      const amountWei = BigInt(payout.amountWei);
      if (!(await this.emission.tryReserve(amountWei))) {
        await this.prisma.tokenPayout.update({ where: { id }, data: { status: 'PENDING' } });
        results.push({ id, status: 'DEFERRED_EMISSION_CAP' });
        continue;
      }

      try {
        const rewardId = ethers.id(payout.id);
        const payReward = vault.getFunction('payReward');
        const tx = await payReward(rewardId, payout.walletAddress, amountWei, payout.id);
        await this.prisma.tokenPayout.update({ where: { id }, data: { status: 'SUBMITTED', txHash: tx.hash } });
        await tx.wait(1);
        await this.prisma.tokenPayout.update({ where: { id }, data: { status: 'CONFIRMED' } });
        await this.audit.log({
          action: 'token.payout.confirmed',
          actorUserId: adminUserId,
          entityType: 'TokenPayout',
          entityId: id,
          data: { txHash: tx.hash },
        });
        results.push({ id, status: 'CONFIRMED', txHash: tx.hash });
      } catch (err) {
        const message = (err as Error).message;
        await this.emission.release(amountWei); // give back the unminted reservation
        await this.prisma.tokenPayout.update({ where: { id }, data: { status: 'FAILED', errorMessage: message } });
        // refund the converted credits (idempotent per payout)
        await this.credits.grant(payout.userId, this.weiToCredits(payout.amountWei), 'payout.refund', `refund:${id}`);
        this.logger.error(`payout ${id} failed: ${message}`);
        results.push({ id, status: 'FAILED', error: message });
      }
    }
    return { processed: results.length, results };
  }
}
