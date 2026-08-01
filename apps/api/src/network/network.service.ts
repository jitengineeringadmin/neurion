import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface HistoryPoint {
  t: number;
  nodesOnline: number;
  jobsInFlight: number;
  jobsCompletedTotal: number;
  tps: number | null;
}

export interface ModelCount {
  model: string;
  nodes: number;
}
export interface TypeCount {
  type: string;
  count: number;
}

export interface NetworkStats {
  generatedAt: string;
  overview: {
    nodesOnline: number;
    nodesActive: number;
    nodesTotal: number;
    jobsInFlight: number;
    jobsCompletedToday: number;
    jobsCompletedTotal: number;
  };
  composition: {
    byStatus: Record<string, number>;
    byTrust: Record<string, number>;
    byOs: Record<string, number>;
    byRegion: Record<string, number>;
    gpuNodes: number;
    cpuOnlyNodes: number;
    dockerNodes: number;
    realtimeNodes: number;
    gridNodes: number;
    totalCpuCores: number;
    models: ModelCount[];
  };
  health: {
    jobSuccessRate: number | null;
    verificationPassRate: number | null;
    jobsByType: TypeCount[];
    verifiedJobs: number;
    optimisticJobs: number;
  };
  // Phase-2 data: stays null/0 until the node-agent reports it.
  performance: {
    avgTokensPerSecond: number | null;
    avgFirstTokenMs: number | null;
    nodesReporting: number;
    gpuModels: ModelCount[];
  };
}

function toRecord(
  rows: Array<Record<string, unknown> & { _count: number }>,
  key: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = r[key] == null ? "unknown" : String(r[key]);
    out[k] = r._count;
  }
  return out;
}

@Injectable()
export class NetworkService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  private cache: { at: number; data: NetworkStats } | null = null;

  // In-memory time-series ring buffer (single-instance prod): no table, no
  // migration. Resets on restart — fine for a live status page. ~12h at 2min.
  private readonly HISTORY_CAP = 360;
  private history: HistoryPoint[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  onModuleInit(): void {
    void this.snapshot();
    this.timer = setInterval(() => void this.snapshot(), 120_000);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private async snapshot(): Promise<void> {
    try {
      const s = await this.stats();
      this.history.push({
        t: Date.now(),
        nodesOnline: s.overview.nodesOnline,
        jobsInFlight: s.overview.jobsInFlight,
        jobsCompletedTotal: s.overview.jobsCompletedTotal,
        tps: s.performance.avgTokensPerSecond,
      });
      if (this.history.length > this.HISTORY_CAP)
        this.history = this.history.slice(-this.HISTORY_CAP);
    } catch {
      /* a transient DB hiccup must not kill the timer */
    }
  }

  getHistory(): HistoryPoint[] {
    return this.history;
  }

  // Public, unauthenticated endpoint -> short server-side cache so it is
  // flood-resistant and never hammers the DB faster than the data changes.
  async stats(): Promise<NetworkStats> {
    if (this.cache && Date.now() - this.cache.at < 5_000)
      return this.cache.data;
    const data = await this.compute();
    this.cache = { at: Date.now(), data };
    return data;
  }

  private async compute(): Promise<NetworkStats> {
    const p = this.prisma;
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const successStatuses = ["COMPLETED", "VERIFIED", "REWARDED"] as const;

    const [
      nodesTotal,
      nodesOnline,
      nodesActive,
      jobsPending,
      jobsRunning,
      jobsCompletedToday,
      jobsSuccess,
      jobsFailed,
      gpuNodes,
      dockerNodes,
      realtimeNodes,
      gridNodes,
      cpuCoresAgg,
      byStatusRaw,
      byTrustRaw,
      byOsRaw,
      byRegionRaw,
      byTypeRaw,
      verifPass,
      verifTotal,
      verifiedJobs,
      optimisticJobs,
      nodeRows,
    ] = await Promise.all([
      p.computeNode.count(),
      p.computeNode.count({ where: { status: "ONLINE" } }),
      p.computeNode.count({ where: { lifecycleState: "ACTIVE" } }),
      p.job.count({ where: { status: "PENDING" } }),
      p.job.count({ where: { status: "RUNNING" } }),
      p.job.count({
        where: {
          status: { in: [...successStatuses] },
          completedAt: { gte: startOfDay },
        },
      }),
      p.job.count({ where: { status: { in: [...successStatuses] } } }),
      p.job.count({ where: { status: "FAILED" } }),
      p.computeNode.count({ where: { nvidiaAvailable: true } }),
      p.computeNode.count({ where: { dockerAvailable: true } }),
      p.computeNode.count({ where: { supportedModes: { has: "realtime" } } }),
      p.computeNode.count({ where: { supportedModes: { has: "grid" } } }),
      p.computeNode.aggregate({ _sum: { cpuCores: true } }),
      p.computeNode.groupBy({ by: ["status"], _count: true }),
      p.computeNode.groupBy({ by: ["trustLevel"], _count: true }),
      p.computeNode.groupBy({ by: ["os"], _count: true }),
      p.computeNode.groupBy({ by: ["regionCode"], _count: true }),
      p.job.groupBy({ by: ["type"], _count: true }),
      p.jobVerification.count({ where: { sampled: true, outcome: "PASS" } }),
      p.jobVerification.count({
        where: { sampled: true, outcome: { in: ["PASS", "FAIL"] } },
      }),
      p.job.count({ where: { nrnPayoutEligible: true } }),
      p.job.count({ where: { grantedOptimistically: true } }),
      p.computeNode.findMany({
        select: {
          loadedModels: true,
          gpuModel: true,
          avgTokensPerSecond: true,
          avgFirstTokenMs: true,
        },
      }),
    ]);

    // Array-column aggregation (Prisma can't groupBy array elements) — fleet is
    // small, tally in memory. Identity-free: model name + count only.
    const modelTally = new Map<string, number>();
    const gpuTally = new Map<string, number>();
    let tpsSum = 0;
    let tpsCount = 0;
    let ftSum = 0;
    let ftCount = 0;
    for (const n of nodeRows) {
      for (const m of n.loadedModels)
        modelTally.set(m, (modelTally.get(m) ?? 0) + 1);
      if (n.gpuModel)
        gpuTally.set(n.gpuModel, (gpuTally.get(n.gpuModel) ?? 0) + 1);
      if (n.avgTokensPerSecond && n.avgTokensPerSecond > 0) {
        tpsSum += n.avgTokensPerSecond;
        tpsCount += 1;
      }
      if (n.avgFirstTokenMs && n.avgFirstTokenMs > 0) {
        ftSum += n.avgFirstTokenMs;
        ftCount += 1;
      }
    }
    const topCounts = (m: Map<string, number>): ModelCount[] =>
      [...m.entries()]
        .map(([model, nodes]) => ({ model, nodes }))
        .sort((a, b) => b.nodes - a.nodes)
        .slice(0, 12);

    const successTotal = jobsSuccess + jobsFailed;

    return {
      generatedAt: new Date().toISOString(),
      overview: {
        nodesOnline,
        nodesActive,
        nodesTotal,
        jobsInFlight: jobsPending + jobsRunning,
        jobsCompletedToday,
        jobsCompletedTotal: jobsSuccess,
      },
      composition: {
        byStatus: toRecord(byStatusRaw as never, "status"),
        byTrust: toRecord(byTrustRaw as never, "trustLevel"),
        byOs: toRecord(byOsRaw as never, "os"),
        byRegion: toRecord(byRegionRaw as never, "regionCode"),
        gpuNodes,
        cpuOnlyNodes: Math.max(0, nodesTotal - gpuNodes),
        dockerNodes,
        realtimeNodes,
        gridNodes,
        totalCpuCores: cpuCoresAgg._sum.cpuCores ?? 0,
        models: topCounts(modelTally),
      },
      health: {
        jobSuccessRate: successTotal > 0 ? jobsSuccess / successTotal : null,
        verificationPassRate: verifTotal > 0 ? verifPass / verifTotal : null,
        jobsByType: (
          byTypeRaw as never as Array<{ type: string; _count: number }>
        )
          .map((r) => ({ type: r.type, count: r._count }))
          .sort((a, b) => b.count - a.count),
        verifiedJobs,
        optimisticJobs,
      },
      performance: {
        avgTokensPerSecond: tpsCount > 0 ? tpsSum / tpsCount : null,
        avgFirstTokenMs: ftCount > 0 ? Math.round(ftSum / ftCount) : null,
        nodesReporting: tpsCount,
        gpuModels: topCounts(gpuTally),
      },
    };
  }
}
