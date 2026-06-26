import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { JobsService } from '../jobs/jobs.service';
import { NodeGatewayService } from '../nodes/node-gateway.service';
import { AuditService } from '../audit/audit.service';
import { AgentTool, ToolCtx } from './agent.types';

const pexec = promisify(exec);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tools the agent can call. Includes filesystem + shell tools (Claude-Code-like).
 * FS/shell access is FULL DISK by user choice; every call is written to AuditLog
 * and can be disabled with AGENT_FS_ENABLED=false.
 */
@Injectable()
export class AgentToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly jobs: JobsService,
    private readonly gateway: NodeGatewayService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private fsEnabled(): boolean {
    return String(this.config.get('AGENT_FS_ENABLED') ?? 'true') !== 'false';
  }

  private async logAction(ctx: ToolCtx, action: string, data: Record<string, unknown>): Promise<void> {
    await this.audit.log({ action: `agent.${action}`, actorUserId: ctx.user.sub, entityType: 'Agent', data });
  }

  tools(): AgentTool[] {
    return [...this.networkTools(), ...this.fileTools()];
  }

  private networkTools(): AgentTool[] {
    return [
      {
        name: 'get_credits',
        description: "Get the user's current internal credit balance.",
        params: {},
        run: async (_a, ctx) => `balance = ${await this.credits.getBalance(ctx.user.sub)} credits`,
      },
      {
        name: 'list_nodes',
        description: 'List the compute nodes and how many are online.',
        params: {},
        run: async (_a, ctx) => {
          const nodes = await this.prisma.computeNode.findMany({ where: { workspaceId: ctx.user.workspaceId } });
          return JSON.stringify({
            total: nodes.length,
            online: nodes.filter((n) => this.gateway.isOnline(n.id)).length,
            nodes: nodes.map((n) => ({ name: n.name, status: this.gateway.isOnline(n.id) ? 'ONLINE' : n.status, trust: n.trustLevel })),
          });
        },
      },
      {
        name: 'create_grid_job',
        description: 'Run a distributed grid job on the network and return its result.',
        params: { type: '"echo.v1" or "embedding.v1"', text: 'input text' },
        run: async (args, ctx) => {
          const type = String(args.type ?? 'echo.v1');
          if (!['echo.v1', 'embedding.v1'].includes(type)) return `error: unknown job type ${type}`;
          let job;
          try {
            job = await this.jobs.create(ctx.user, type, { text: String(args.text ?? '') } as never);
          } catch (e) {
            return `error creating job: ${(e as Error).message}`;
          }
          for (let i = 0; i < 40; i++) {
            const j = await this.prisma.job.findUnique({ where: { id: job.id } });
            if (j && ['REWARDED', 'VERIFIED', 'COMPLETED', 'FAILED'].includes(j.status)) {
              return JSON.stringify({ status: j.status, output: j.outputJson });
            }
            await sleep(400);
          }
          return `job ${job.id} timed out (no online node?)`;
        },
      },
    ];
  }

  private fileTools(): AgentTool[] {
    const guard = (): string | null => (this.fsEnabled() ? null : 'error: filesystem tools are disabled (AGENT_FS_ENABLED=false)');
    return [
      {
        name: 'read_file',
        description: 'Read a text file from disk. Returns up to 60KB.',
        params: { path: 'absolute or relative file path' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = String(args.path ?? '');
          await this.logAction(ctx, 'read_file', { path });
          try {
            const content = await readFile(path, 'utf8');
            return content.length > 60000 ? content.slice(0, 60000) + '\n…[truncated]' : content;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a text file with the given content.',
        params: { path: 'file path', content: 'full file content' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = String(args.path ?? '');
          await this.logAction(ctx, 'write_file', { path, bytes: String(args.content ?? '').length });
          try {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, String(args.content ?? ''), 'utf8');
            return `wrote ${String(args.content ?? '').length} bytes to ${path}`;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: 'edit_file',
        description: 'Replace all occurrences of a string in a file.',
        params: { path: 'file path', find: 'exact text to find', replace: 'replacement text' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = String(args.path ?? '');
          const find = String(args.find ?? '');
          await this.logAction(ctx, 'edit_file', { path });
          try {
            const before = await readFile(path, 'utf8');
            const count = find ? before.split(find).length - 1 : 0;
            if (count === 0) return `error: "find" text not found in ${path}`;
            await writeFile(path, before.split(find).join(String(args.replace ?? '')), 'utf8');
            return `replaced ${count} occurrence(s) in ${path}`;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: 'list_dir',
        description: 'List the entries of a directory.',
        params: { path: 'directory path' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = String(args.path ?? '.');
          await this.logAction(ctx, 'list_dir', { path });
          try {
            const entries = await readdir(path, { withFileTypes: true });
            return JSON.stringify(entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).slice(0, 300));
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: 'run_command',
        description: 'Run a shell command on the machine and return its output. Use for builds, git, tests, scripts.',
        params: { command: 'the shell command', cwd: 'optional working directory' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const command = String(args.command ?? '');
          const cwd = args.cwd ? String(args.cwd) : process.cwd();
          await this.logAction(ctx, 'run_command', { command, cwd });
          try {
            await stat(cwd).catch(() => undefined);
            const { stdout, stderr } = await pexec(command, { cwd, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
            const out = `${stdout}${stderr}`.trim();
            return out ? out.slice(0, 6000) : 'ok (no output)';
          } catch (e) {
            const err = e as { message: string; stdout?: string; stderr?: string };
            return `error: ${err.message}\n${(err.stdout ?? '') + (err.stderr ?? '')}`.slice(0, 6000);
          }
        },
      },
    ];
  }
}
