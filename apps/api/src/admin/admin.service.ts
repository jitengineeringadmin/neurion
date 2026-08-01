import { Injectable } from "@nestjs/common";
import { NodeTrustLevel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  setNodeTrustLevel(id: string, trustLevel: NodeTrustLevel) {
    return this.prisma.computeNode.update({
      where: { id },
      data: { trustLevel },
    });
  }

  async dashboard() {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const [
      totalUsers,
      activeUsers,
      activeNodes,
      onlineNodes,
      jobsPending,
      jobsRunning,
      jobsCompletedToday,
      chatMessagesToday,
      failedJobs,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: "ACTIVE" } }),
      this.prisma.computeNode.count({ where: { lifecycleState: "ACTIVE" } }),
      this.prisma.computeNode.count({ where: { status: "ONLINE" } }),
      this.prisma.job.count({ where: { status: "PENDING" } }),
      this.prisma.job.count({ where: { status: "RUNNING" } }),
      this.prisma.job.count({
        where: { status: "COMPLETED", completedAt: { gte: startOfDay } },
      }),
      this.prisma.chatMessage.count({
        where: { createdAt: { gte: startOfDay } },
      }),
      this.prisma.job.count({ where: { status: "FAILED" } }),
    ]);

    const creditAgg = await this.prisma.creditLedger.aggregate({
      _sum: { amount: true },
    });
    const creditsNet = creditAgg._sum.amount ?? 0;

    return {
      users: { total: totalUsers, active: activeUsers },
      nodes: { active: activeNodes, online: onlineNodes },
      jobs: {
        pending: jobsPending,
        running: jobsRunning,
        completedToday: jobsCompletedToday,
        failed: failedJobs,
      },
      chat: { messagesToday: chatMessagesToday },
      credits: { netInLedger: creditsNet },
      generatedAt: new Date().toISOString(),
    };
  }
}
