import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ethers } from "ethers";
import { PrismaService } from "../prisma/prisma.service";
import { CreditsService } from "../credits/credits.service";
import { AuditService } from "../audit/audit.service";
import { TokenConfigService } from "./token-config.service";
import { EmissionService } from "./emission.service";
import { AuthUser } from "../common/decorators/current-user.decorator";

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
    if (credits <= 0) throw new BadRequestException("credits must be positive");
    if (!this.config.payoutsEnabled)
      throw new ForbiddenException("token payouts are disabled");

    const dbUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.sub },
    });
    if (!dbUser.walletAddress)
      throw new BadRequestException("link a wallet first");
    if (
      dbUser.payoutHold ||
      dbUser.kycStatus === "PAYOUT_BLOCKED" ||
      dbUser.kycStatus === "KYC_REJECTED"
    ) {
      throw new ForbiddenException("payouts blocked for this account");
    }
    // The threshold applies to what this account has cashed out in total over a
    // rolling window, not to one request in isolation: checking a single amount
    // let anyone stay under it forever by splitting one payout into several.
    const threshold = Number(
      process.env["KYC_PAYOUT_THRESHOLD_CREDITS"] ?? 1000,
    );
    if (dbUser.kycStatus !== "KYC_APPROVED") {
      const windowDays = Number(process.env["KYC_PAYOUT_WINDOW_DAYS"] ?? 30);
      const since = new Date(Date.now() - windowDays * 24 * 3600_000);
      const prior = await this.prisma.tokenPayout.aggregate({
        where: {
          userId: user.sub,
          createdAt: { gte: since },
          status: { notIn: ["FAILED", "CANCELLED"] },
        },
        _sum: { grossCredits: true },
      });
      const already = prior._sum.grossCredits ?? 0;
      if (already + credits >= threshold) {
        throw new ForbiddenException(
          `KYC required: ${already + credits} credits in the last ${windowDays} days reaches the ${threshold} limit`,
        );
      }
    }

    // convert: spend the credits now (refunded if the send never reaches the chain)
    await this.credits.spend(user.sub, credits, "payout.request");
    // protocol take-rate (PROTOCOL_FEE_BPS) on cash-out -> treasury; user receives NRN for the net
    const fee = await this.credits.collectFee(
      credits,
      `payout:${user.sub}:${Date.now()}`,
    );
    const net = credits - fee;

    const payout = await this.prisma.tokenPayout.create({
      data: {
        userId: user.sub,
        walletAddress: dbUser.walletAddress,
        amountWei: this.creditsToWei(net).toString(),
        chainId: this.config.chainId,
        status: "PENDING",
        // Recorded so a failure can refund what was actually paid, fee included.
        grossCredits: credits,
        feeCredits: fee,
      },
    });
    await this.audit.log({
      action: "token.payout.requested",
      actorUserId: user.sub,
      entityType: "TokenPayout",
      entityId: payout.id,
      data: { credits },
    });
    return payout;
  }

  async listPayouts(user: AuthUser) {
    return this.prisma.tokenPayout.findMany({
      where: { userId: user.sub },
      orderBy: { createdAt: "desc" },
    });
  }

  async getPayout(user: AuthUser, id: string) {
    const p = await this.prisma.tokenPayout.findUnique({ where: { id } });
    if (!p) throw new NotFoundException("payout not found");
    if (p.userId !== user.sub) throw new ForbiddenException("not your payout");
    return p;
  }

  /** Admin: submit all PENDING payouts on-chain via the ComputeRewardVault. */
  async processPayouts(adminUserId: string) {
    if (!this.config.payoutsEnabled)
      throw new ForbiddenException("token payouts are disabled");
    const candidates = await this.prisma.tokenPayout.findMany({
      where: { status: "PENDING" },
      take: 50,
      select: { id: true },
    });
    const vault = this.config.signerVault();
    const results: Array<{
      id: string;
      status: string;
      txHash?: string;
      error?: string;
    }> = [];

    for (const { id } of candidates) {
      // Atomic claim: only one concurrent run flips PENDING -> PROCESSING, so a
      // payout is never submitted (and refunded) twice.
      const claim = await this.prisma.tokenPayout.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "PROCESSING" },
      });
      if (claim.count !== 1) continue;
      const payout = await this.prisma.tokenPayout.findUniqueOrThrow({
        where: { id },
      });

      // G12: reserve emission before paying; defer if it would exceed the cap.
      const amountWei = BigInt(payout.amountWei);
      if (!(await this.emission.tryReserve(amountWei))) {
        await this.prisma.tokenPayout.update({
          where: { id },
          data: { status: "PENDING" },
        });
        results.push({ id, status: "DEFERRED_EMISSION_CAP" });
        continue;
      }

      // Tracks whether the transaction ever left this process. Everything before
      // that point can be safely undone; nothing after it can.
      let submitted = false;
      try {
        const rewardId = ethers.id(payout.id);
        const payReward = vault.getFunction("payReward");
        const tx = await payReward(
          rewardId,
          payout.walletAddress,
          amountWei,
          payout.id,
        );
        submitted = true;
        await this.prisma.tokenPayout.update({
          where: { id },
          data: {
            status: "SUBMITTED",
            txHash: tx.hash,
            submittedAt: new Date(),
          },
        });
        await tx.wait(1);
        await this.prisma.tokenPayout.update({
          where: { id },
          data: { status: "CONFIRMED" },
        });
        await this.audit.log({
          action: "token.payout.confirmed",
          actorUserId: adminUserId,
          entityType: "TokenPayout",
          entityId: id,
          data: { txHash: tx.hash },
        });
        results.push({ id, status: "CONFIRMED", txHash: tx.hash });
      } catch (err) {
        const message = (err as Error).message;

        if (submitted) {
          // The send is already on the chain. Waiting for it can fail for
          // reasons that say nothing about the transaction — an RPC timeout, a
          // dropped connection, this process restarting — and it may confirm
          // seconds later. Refunding here would hand the user both the tokens
          // and their credits back, so the payout stays SUBMITTED and is left
          // for reconciliation against its txHash. The emission reservation is
          // likewise NOT released: those tokens may well have been minted.
          await this.prisma.tokenPayout.update({
            where: { id },
            data: { errorMessage: `confirmation not observed: ${message}` },
          });
          this.logger.error(
            `payout ${id} submitted but not confirmed (${message}) — left SUBMITTED for reconciliation, NOT refunded`,
          );
          results.push({ id, status: "SUBMITTED_UNCONFIRMED", error: message });
          continue;
        }

        // Never reached the chain: undo everything.
        await this.emission.release(amountWei);
        await this.prisma.tokenPayout.update({
          where: { id },
          data: { status: "FAILED", errorMessage: message },
        });
        // Refund what the user actually paid — the gross, fee included. Refunding
        // the net (all amountWei ever held) kept the fee on a payout that never
        // happened. Older rows have no gross recorded; fall back to the net.
        const refund =
          payout.grossCredits > 0
            ? payout.grossCredits
            : this.weiToCredits(payout.amountWei);
        await this.credits.grant(
          payout.userId,
          refund,
          "payout.refund",
          `refund:${id}`,
        );
        this.logger.error(
          `payout ${id} failed before submission: ${message} — refunded ${refund} credits`,
        );
        results.push({ id, status: "FAILED", error: message });
      }
    }
    return { processed: results.length, results };
  }
}
