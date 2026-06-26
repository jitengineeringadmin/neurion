import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir, stat, rm, rename } from 'node:fs/promises';
import { dirname, join, basename, isAbsolute } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { JobsService } from '../jobs/jobs.service';
import { NodeGatewayService } from '../nodes/node-gateway.service';
import { AuditService } from '../audit/audit.service';
import { AgentMemoryService } from './agent-memory.service';
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
    private readonly memory: AgentMemoryService,
  ) {}

  private fsEnabled(): boolean {
    return String(this.config.get('AGENT_FS_ENABLED') ?? 'true') !== 'false';
  }

  /** Resolve a possibly-relative path against the project working directory. */
  private resolve(ctx: ToolCtx, p: string): string {
    return p && ctx.cwd && !isAbsolute(p) ? join(ctx.cwd, p) : p;
  }

  private async logAction(ctx: ToolCtx, action: string, data: Record<string, unknown>): Promise<void> {
    await this.audit.log({ action: `agent.${action}`, actorUserId: ctx.user.sub, entityType: 'Agent', data });
  }

  tools(): AgentTool[] {
    return [
      ...this.networkTools(),
      ...this.fileTools(),
      ...this.devTools(),
      ...this.projectTools(),
      ...this.planTools(),
      ...this.memoryTools(),
    ];
  }

  private memoryTools(): AgentTool[] {
    return [
      {
        name: 'remember',
        description: 'Save a fact to persistent memory so you recall it in future sessions.',
        params: { note: 'the fact to remember' },
        run: async (args, ctx) => {
          await this.memory.save(ctx.user.sub, String(args.note ?? ''));
          return 'remembered';
        },
      },
      {
        name: 'recall',
        description: 'List facts saved in persistent memory.',
        params: {},
        run: async (_a, ctx) => {
          const m = await this.memory.recent(ctx.user.sub);
          return m.length ? m.map((x) => '- ' + x.content).join('\n') : 'no memories';
        },
      },
    ];
  }

  private planTools(): AgentTool[] {
    return [
      {
        name: 'set_plan',
        description: 'Set a step-by-step plan for a multi-step goal. Call this first for non-trivial goals.',
        params: { steps: 'array of short step descriptions' },
        run: async (args, ctx) => {
          const steps = Array.isArray(args.steps) ? (args.steps as unknown[]).map(String) : [];
          ctx.emit('agent.plan', { steps: steps.map((text) => ({ text, done: false })) });
          return `plan set with ${steps.length} step(s)`;
        },
      },
      {
        name: 'update_plan',
        description: 'Mark a plan step as done (0-based index).',
        params: { index: 'step index', done: 'true/false' },
        run: async (args, ctx) => {
          ctx.emit('agent.plan_update', { index: Number(args.index ?? 0), done: args.done !== false });
          return `step ${Number(args.index ?? 0)} updated`;
        },
      },
      {
        name: 'read_many_files',
        description: 'Read several files at once. Returns each prefixed by its path.',
        params: { paths: 'array of file paths' },
        run: async (args, ctx) => {
          const g = this.fsEnabled() ? null : 'error: filesystem tools are disabled';
          if (g) return g;
          const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : [];
          await this.logAction(ctx, 'read_many_files', { count: paths.length });
          const parts: string[] = [];
          for (const p of paths.slice(0, 20)) {
            try {
              parts.push(`=== ${p} ===\n${(await readFile(p, 'utf8')).slice(0, 20000)}`);
            } catch (e) {
              parts.push(`=== ${p} ===\nerror: ${(e as Error).message}`);
            }
          }
          return parts.join('\n\n');
        },
      },
    ];
  }

  private projectTools(): AgentTool[] {
    const guard = (): string | null => (this.fsEnabled() ? null : 'error: filesystem tools are disabled');
    type File = { p: string; c: string };
    const templates: Record<string, (n: string) => File[]> = {
      node: (n) => [
        { p: 'package.json', c: JSON.stringify({ name: n, version: '0.1.0', type: 'module', scripts: { start: 'node src/index.js' } }, null, 2) + '\n' },
        { p: 'src/index.js', c: `console.log('hello from ${n}');\n` },
        { p: 'README.md', c: `# ${n}\n` },
        { p: '.gitignore', c: 'node_modules/\n' },
      ],
      python: (n) => [
        { p: 'pyproject.toml', c: `[project]\nname = "${n}"\nversion = "0.1.0"\n` },
        { p: 'main.py', c: `def main():\n    print("hello from ${n}")\n\n\nif __name__ == "__main__":\n    main()\n` },
        { p: 'README.md', c: `# ${n}\n` },
        { p: '.gitignore', c: '__pycache__/\n.venv/\n' },
      ],
      go: (n) => [
        { p: 'go.mod', c: `module ${n}\n\ngo 1.22\n` },
        { p: 'main.go', c: `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello from ${n}")\n}\n` },
        { p: 'README.md', c: `# ${n}\n` },
      ],
      static: (n) => [
        { p: 'index.html', c: `<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>${n}</title><link rel="stylesheet" href="style.css"></head>\n<body><h1>${n}</h1><script src="script.js"></script></body>\n</html>\n` },
        { p: 'style.css', c: 'body { font-family: system-ui; margin: 2rem; }\n' },
        { p: 'script.js', c: `console.log('${n}');\n` },
        { p: 'README.md', c: `# ${n}\n` },
      ],
      empty: (n) => [{ p: 'README.md', c: `# ${n}\n` }, { p: '.gitignore', c: '' }],
    };
    return [
      {
        name: 'create_project',
        description: `Scaffold a new project. type one of: ${Object.keys(templates).join(', ')}.`,
        params: { path: 'directory to create the project in', type: 'project type', name: 'optional project name' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = this.resolve(ctx, String(args.path ?? ''));
          if (!path) return 'error: path required';
          const type = String(args.type ?? 'node');
          const name = String(args.name ?? (basename(path) || 'app'));
          const make = (templates[type] ?? templates.node) as (n: string) => File[];
          await this.logAction(ctx, 'create_project', { path, type, name });
          const created: string[] = [];
          try {
            for (const f of make(name)) {
              const full = join(path, f.p);
              await mkdir(dirname(full), { recursive: true });
              await writeFile(full, f.c, 'utf8');
              created.push(f.p);
            }
            return `created ${type} project "${name}" at ${path}:\n${created.join('\n')}`;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: 'apply_patch',
        description: 'Apply multiple file edits at once. edits: array of {path, content} (overwrite) or {path, find, replace}.',
        params: { edits: 'array of edit objects' },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : [];
          await this.logAction(ctx, 'apply_patch', { files: edits.length });
          const out: string[] = [];
          for (const e of edits.slice(0, 30)) {
            const path = String(e.path ?? '');
            if (!path) {
              out.push('skip: missing path');
              continue;
            }
            try {
              if (e.content !== undefined) {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, String(e.content), 'utf8');
                out.push(`wrote ${path}`);
              } else {
                const before = await readFile(path, 'utf8');
                const find = String(e.find ?? '');
                const count = find ? before.split(find).length - 1 : 0;
                if (count === 0) {
                  out.push(`no match in ${path}`);
                } else {
                  await writeFile(path, before.split(find).join(String(e.replace ?? '')), 'utf8');
                  out.push(`edited ${path} (${count}x)`);
                }
              }
            } catch (err) {
              out.push(`error ${path}: ${(err as Error).message}`);
            }
          }
          return out.join('\n');
        },
      },
    ];
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
          const dir = this.resolve(ctx, String(args.dir ?? '.'));
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
          const dir = this.resolve(ctx, String(args.dir ?? '.'));
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
        run: async (args, ctx) => {
          try {
            const s = await stat(this.resolve(ctx, String(args.path ?? '')));
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
          const path = this.resolve(ctx, String(args.path ?? ''));
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
          const path = this.resolve(ctx, String(args.path ?? ''));
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
          const from = this.resolve(ctx, String(args.from ?? ''));
          const to = this.resolve(ctx, String(args.to ?? ''));
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
          const path = this.resolve(ctx, String(args.path ?? ''));
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
          const path = this.resolve(ctx, String(args.path ?? ''));
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
          const path = this.resolve(ctx, String(args.path ?? ''));
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
          const path = this.resolve(ctx, String(args.path ?? ''));
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
          const path = this.resolve(ctx, String(args.path ?? '.'));
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
          const cwd = args.cwd ? this.resolve(ctx, String(args.cwd)) : (ctx.cwd ?? process.cwd());
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
