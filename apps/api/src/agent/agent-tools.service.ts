import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir, stat, rm, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
    return [...this.networkTools(), ...this.fileTools(), ...this.devTools()];
  }

  private static readonly SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.turbo', 'cache']);

  private async walk(dir: string, depth: number, fn: (path: string) => Promise<void>): Promise<void> {
    if (depth > 7) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (AgentToolsService.SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await this.walk(full, depth + 1, fn);
      else await fn(full);
    }
  }

  private devTools(): AgentTool[] {
    const guard = (): string | null => (this.fsEnabled() ? null : 'error: filesystem tools are disabled');
    return [
      {
        name: 'search_files',
        description: 'Recursively search for text inside files under a directory. Returns matches as path:line.',
        params: { dir: 'directory to search', query: 'text to find' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const dir = String(args.dir ?? '.');
          const query = String(args.query ?? '');
          if (!query) return 'error: empty query';
          await this.logAction(ctx, 'search_files', { dir, query });
          const hits: string[] = [];
          await this.walk(dir, 0, async (path) => {
            if (hits.length >= 80) return;
            try {
              const st = await stat(path);
              if (st.size > 2_000_000) return;
              const lines = (await readFile(path, 'utf8')).split('\n');
              for (let i = 0; i < lines.length && hits.length < 80; i++) {
                if (lines[i]!.includes(query)) hits.push(`${path}:${i + 1}: ${lines[i]!.trim().slice(0, 160)}`);
              }
            } catch {
              /* binary / unreadable */
            }
          });
          return hits.length ? hits.join('\n') : 'no matches';
        },
      },
      {
        name: 'find_files',
        description: 'Recursively find files by name glob (e.g. "*.ts", "package.json").',
        params: { dir: 'directory to search', pattern: 'filename glob' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const dir = String(args.dir ?? '.');
          const pattern = String(args.pattern ?? '*');
          await this.logAction(ctx, 'find_files', { dir, pattern });
          const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
          const out: string[] = [];
          await this.walk(dir, 0, async (path) => {
            if (out.length >= 150) return;
            if (re.test(path.split(/[/\\]/).pop() ?? '')) out.push(path);
          });
          return out.length ? out.join('\n') : 'no files';
        },
      },
      {
        name: 'web_fetch',
        description: 'HTTP GET a URL and return the response text (read-only). Use for docs/APIs.',
        params: { url: 'the URL to fetch' },
        run: async (args, ctx) => {
          const url = String(args.url ?? '');
          if (!/^https?:\/\//.test(url)) return 'error: url must start with http(s)://';
          await this.logAction(ctx, 'web_fetch', { url });
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 15000);
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(t);
            const text = await res.text();
            return `HTTP ${res.status}\n${text.slice(0, 50000)}`;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: 'stat_path',
        description: 'Get info about a file or directory (size, type, modified time).',
        params: { path: 'file or directory path' },
        run: async (args, _ctx) => {
          try {
            const s = await stat(String(args.path ?? ''));
            return JSON.stringify({ type: s.isDirectory() ? 'dir' : 'file', sizeBytes: s.size, modified: s.mtime.toISOString() });
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: 'make_dir',
        description: 'Create a directory (and parents).',
        params: { path: 'directory path' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = String(args.path ?? '');
          await this.logAction(ctx, 'make_dir', { path });
          try {
            await mkdir(path, { recursive: true });
            return `created ${path}`;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: 'append_file',
        description: 'Append text to the end of a file (creates it if missing).',
        params: { path: 'file path', content: 'text to append' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = String(args.path ?? '');
          await this.logAction(ctx, 'append_file', { path, bytes: String(args.content ?? '').length });
          try {
            await mkdir(dirname(path), { recursive: true });
            const prev = await readFile(path, 'utf8').catch(() => '');
            await writeFile(path, prev + String(args.content ?? ''), 'utf8');
            return `appended ${String(args.content ?? '').length} bytes to ${path}`;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: 'move_path',
        description: 'Move or rename a file or directory.',
        params: { from: 'source path', to: 'destination path' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const from = String(args.from ?? '');
          const to = String(args.to ?? '');
          await this.logAction(ctx, 'move_path', { from, to });
          try {
            await rename(from, to);
            return `moved ${from} -> ${to}`;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: 'delete_path',
        description: 'Delete a file or directory (recursive).',
        params: { path: 'path to delete' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = String(args.path ?? '');
          await this.logAction(ctx, 'delete_path', { path });
          try {
            await rm(path, { recursive: true, force: true });
            return `deleted ${path}`;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
    ];
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
