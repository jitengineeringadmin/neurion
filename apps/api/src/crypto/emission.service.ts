import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

// Sensible defaults (18-decimal wei): 1,000,000 NRN/day epoch budget, 400,000,000 NRN lifetime pool cap.
const DEFAULT_EPOCH_BUDGET_WEI = (1_000_000n * 10n ** 18n).toString();
const DEFAULT_POOL_CAP_WEI = (400_000_000n * 10n ** 18n).toString();

/**
 * G12 emission cap. Enforces a per-epoch (UTC day) budget and a lifetime pool
 * cap on on-chain NRN emission. Reservations use optimistic concurrency (CAS on
 * the stored string amount) so concurrent payouts can't over-emit.
 */
@Injectable()
export class EmissionService {
  private readonly logger = new Logger(EmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private epochKey(): string {
    return new Date().toISOString().slice(0, 10); // UTC yyyy-mm-dd
  }
  private budgetWei(): bigint {
    return BigInt(this.config.get<string>('EMISSION_EPOCH_BUDGET_WEI') ?? DEFAULT_EPOCH_BUDGET_WEI);
  }
  private poolCapWei(): bigint {
    return BigInt(this.config.get<string>('EMISSION_POOL_CAP_WEI') ?? DEFAULT_POOL_CAP_WEI);
  }

  /** Global lifetime emitted = sum of every epoch's emittedThisEpochWei. */
  private async lifetimeWei(): Promise<bigint> {
    const rows = await this.prisma.emissionSchedule.findMany({ select: { emittedThisEpochWei: true } });
    return rows.reduce((acc, r) => acc + BigInt(r.emittedThisEpochWei), 0n);
  }

  /**
   * Try to reserve `amountWei` of emission for the current epoch. Returns false
   * (without reserving) when it would exceed the epoch budget or the pool cap.
   */
  async tryReserve(amountWei: bigint): Promise<boolean> {
    if (amountWei <= 0n) return true;
    const epochKey = this.epochKey();
    const budget = this.budgetWei();
    const poolCap = this.poolCapWei();

    await this.prisma.emissionSchedule.upsert({
      where: { epochKey },
      update: {},
      create: { epochKey, epochBudgetWei: budget.toString(), poolCapWei: poolCap.toString(), emittedThisEpochWei: '0', emittedLifetimeWei: '0' },
    });

    for (let attempt = 0; attempt < 6; attempt++) {
      const row = await this.prisma.emissionSchedule.findUniqueOrThrow({ where: { epochKey } });
      const epochEmitted = BigInt(row.emittedThisEpochWei);
      const lifetime = await this.lifetimeWei();
      if (epochEmitted + amountWei > budget) {
        this.logger.warn(`emission denied: epoch budget exceeded (${epochKey})`);
        return false;
      }
      if (lifetime + amountWei > poolCap) {
        this.logger.warn('emission denied: lifetime pool cap exceeded');
        return false;
      }
      // CAS: only commit if no other reservation changed the epoch counter meanwhile.
      const res = await this.prisma.emissionSchedule.updateMany({
        where: { epochKey, emittedThisEpochWei: row.emittedThisEpochWei },
        data: {
          emittedThisEpochWei: (epochEmitted + amountWei).toString(),
          emittedLifetimeWei: (lifetime + amountWei).toString(),
        },
      });
      if (res.count === 1) return true;
      // contended — retry with fresh values
    }
    this.logger.warn('emission reserve gave up after contention');
    return false;
  }

  /** Release a previously reserved amount (e.g. the on-chain payout failed). */
  async release(amountWei: bigint): Promise<void> {
    if (amountWei <= 0n) return;
    const epochKey = this.epochKey();
    for (let attempt = 0; attempt < 6; attempt++) {
      const row = await this.prisma.emissionSchedule.findUnique({ where: { epochKey } });
      if (!row) return;
      const epochEmitted = BigInt(row.emittedThisEpochWei);
      const lifetime = BigInt(row.emittedLifetimeWei);
      const next = epochEmitted > amountWei ? epochEmitted - amountWei : 0n;
      const nextLifetime = lifetime > amountWei ? lifetime - amountWei : 0n;
      const res = await this.prisma.emissionSchedule.updateMany({
        where: { epochKey, emittedThisEpochWei: row.emittedThisEpochWei },
        data: { emittedThisEpochWei: next.toString(), emittedLifetimeWei: nextLifetime.toString() },
      });
      if (res.count === 1) return;
    }
  }
}
