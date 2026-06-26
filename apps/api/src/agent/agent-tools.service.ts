import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { JobsService } from '../jobs/jobs.service';
import { NodeGatewayService } from '../nodes/node-gateway.service';
import { AgentTool, ToolCtx } from './agent.types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tools the agent can call — each maps to a real Neurion service. */
@Injectable()
export class AgentToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly jobs: JobsService,
    private readonly gateway: NodeGatewayService,
  ) {}

  tools(): AgentTool[] {
    return [
      {
        name: 'get_credits',
        description: "Get the user's current internal credit balance.",
        params: {},
        run: async (_args, ctx: ToolCtx) => `balance = ${await this.credits.getBalance(ctx.user.sub)} credits`,
      },
      {
        name: 'list_nodes',
        description: 'List the compute nodes and how many are online.',
        params: {},
        run: async (_args, ctx: ToolCtx) => {
          const nodes = await this.prisma.computeNode.findMany({ where: { workspaceId: ctx.user.workspaceId } });
          const online = nodes.filter((n) => this.gateway.isOnline(n.id));
          return JSON.stringify({
            total: nodes.length,
            online: online.length,
            nodes: nodes.map((n) => ({ name: n.name, status: this.gateway.isOnline(n.id) ? 'ONLINE' : n.status, trust: n.trustLevel })),
          });
        },
      },
      {
        name: 'create_grid_job',
        description: 'Run a distributed grid job on the network and return its result. Use for compute tasks.',
        params: { type: '"echo.v1" or "embedding.v1"', text: 'the input text for the job' },
        run: async (args, ctx: ToolCtx) => {
          const type = String(args.type ?? 'echo.v1');
          const text = String(args.text ?? '');
          if (!['echo.v1', 'embedding.v1'].includes(type)) return `error: unknown job type ${type}`;
          let job;
          try {
            job = await this.jobs.create(ctx.user, type, { text } as never);
          } catch (e) {
            return `error creating job: ${(e as Error).message}`;
          }
          for (let i = 0; i < 40; i++) {
            const j = await this.prisma.job.findUnique({ where: { id: job.id } });
            if (j && ['REWARDED', 'VERIFIED', 'COMPLETED', 'FAILED'].includes(j.status)) {
              return JSON.stringify({ status: j.status, output: j.outputJson, costCredits: j.costCredits });
            }
            await sleep(400);
          }
          return `job ${job.id} timed out (no online node?)`;
        },
      },
    ];
  }
}
