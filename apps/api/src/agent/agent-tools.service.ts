import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, mkdir, stat, rm, rename } from "node:fs/promises";
import {
  join,
  basename,
  isAbsolute,
  resolve as pathResolve,
  sep,
} from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PrismaService } from "../prisma/prisma.service";
import { CreditsService } from "../credits/credits.service";
import { JobsService } from "../jobs/jobs.service";
import { NodeGatewayService } from "../nodes/node-gateway.service";
import { AuditService } from "../audit/audit.service";
import { AgentMemoryService } from "./agent-memory.service";
import { AgentTool, ToolCtx } from "./agent.types";
import { AgentCodeIndexService } from "./agent-code-index.service";
import { AgentPatchService } from "./agent-patch.service";
import { AgentVerificationService } from "./agent-verification.service";
import { AgentTerminalService } from "./agent-terminal.service";
import { agentToolSchema } from "./agent-tool-validation.service";

const pexec = promisify(exec);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tools the agent can call. Includes filesystem + shell tools (Claude-Code-like).
 * File access is confined to the opened project by default; every call is written
 * to AuditLog and can be disabled with AGENT_FS_ENABLED=false.
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
    private readonly codeIndex: AgentCodeIndexService,
    private readonly patches: AgentPatchService,
    private readonly verification: AgentVerificationService,
    private readonly terminal: AgentTerminalService,
  ) {}

  private fsEnabled(): boolean {
    return String(this.config.get("AGENT_FS_ENABLED") ?? "true") !== "false";
  }

  /** Project confinement is the default security boundary for all file tools. */
  // Only an explicit administrator opt-out disables the project boundary.
  private confineFs(): boolean {
    return (
      String(this.config.get("AGENT_FS_CONFINE_TO_CWD") ?? "true") !== "false"
    );
  }

  /** Resolve a possibly-relative path against the project cwd. When
   * AGENT_FS_CONFINE_TO_CWD=true, reject paths that escape the project dir. */
  private resolve(ctx: ToolCtx, p: string): string {
    if (!p) throw new Error("path is required");
    if ((this.confineFs() || ctx.confine) && !ctx.cwd) {
      throw new Error("open a project folder before using filesystem tools");
    }
    const full = p && ctx.cwd && !isAbsolute(p) ? join(ctx.cwd, p) : p;
    if ((this.confineFs() || ctx.confine) && ctx.cwd && full) {
      const norm = pathResolve(full);
      const base = pathResolve(ctx.cwd);
      if (norm !== base && !norm.startsWith(base + sep)) {
        throw new Error(
          `path escapes the project directory (AGENT_FS_CONFINE_TO_CWD=true): ${p}`,
        );
      }
    }
    return full;
  }

  private assertNotWorkspaceRoot(ctx: ToolCtx, target: string): void {
    if (!ctx.cwd) return;
    if (pathResolve(target) === pathResolve(ctx.cwd)) {
      throw new Error("refusing to modify or delete the project root itself");
    }
  }

  /** True for loopback / private / link-local / CGNAT / metadata IPs (SSRF). */
  private isPrivateIp(ip: string): boolean {
    const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const a = Number(m[1]),
        b = Number(m[2]);
      return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) || // link-local incl. 169.254.169.254 cloud metadata
        (a === 100 && b >= 64 && b <= 127) // CGNAT
      );
    }
    const low = ip.toLowerCase();
    return (
      low === "::1" ||
      low === "::" ||
      low.startsWith("fc") ||
      low.startsWith("fd") ||
      low.startsWith("fe80") ||
      low.startsWith("::ffff:127.") ||
      low.startsWith("::ffff:10.") ||
      low.startsWith("::ffff:169.254") ||
      low.startsWith("::ffff:192.168.")
    );
  }

  /** SSRF guard for web_fetch: only public http(s); block internal hosts + any
   * hostname that resolves to a private IP. Returns an error string or null. */
  private async assertPublicUrl(url: string): Promise<string | null> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return "error: invalid URL";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      return "error: only http(s) URLs are allowed";
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "metadata.google.internal"
    ) {
      return "error: blocked internal host";
    }
    if (isIP(host))
      return this.isPrivateIp(host)
        ? "error: blocked private/loopback IP"
        : null;
    try {
      const addrs = await lookup(host, { all: true });
      if (addrs.some((a) => this.isPrivateIp(a.address)))
        return "error: host resolves to a private/loopback IP";
    } catch {
      return "error: DNS resolution failed";
    }
    return null;
  }

  private async logAction(
    ctx: ToolCtx,
    action: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.log({
      action: `agent.${action}`,
      actorUserId: ctx.user.sub,
      entityType: "Agent",
      data,
    });
  }

  tools(): AgentTool[] {
    const tools = [
      ...this.networkTools(),
      ...this.fileTools(),
      ...this.devTools(),
      ...this.processTools(),
      ...this.projectTools(),
      ...this.codeTools(),
      ...this.planTools(),
      ...this.memoryTools(),
    ];
    return tools.map((tool) => ({
      ...tool,
      inputSchema: tool.inputSchema ?? agentToolSchema(tool.name),
    }));
  }

  private processTools(): AgentTool[] {
    const guard = (ctx: ToolCtx): string | null => {
      if (!this.fsEnabled()) return "error: filesystem tools are disabled";
      if (!ctx.cwd) return "error: open a project folder first";
      return null;
    };
    return [
      {
        name: "start_process",
        description:
          "Start a long-running command and return a process_id immediately. Use for dev servers, watchers and commands that may exceed 30 seconds.",
        params: {
          command: "shell command to start",
          cwd: "optional working directory inside the project",
          timeout_ms: "optional lifetime, from 1000 to 1800000 milliseconds",
        },
        run: async (args, ctx) => {
          const error = guard(ctx);
          if (error) return error;
          const cwd = args.cwd
            ? this.resolve(ctx, String(args.cwd))
            : (ctx.cwd as string);
          const command = String(args.command ?? "");
          const timeout = args.timeout_ms ? Number(args.timeout_ms) : undefined;
          await this.logAction(ctx, "start_process", { command, cwd, timeout });
          return this.terminal.start(command, cwd, ctx, timeout);
        },
      },
      {
        name: "read_process",
        description:
          "Read buffered output and current status for a managed process. Pass next_offset on later reads to receive only new output.",
        params: {
          process_id: "id returned by start_process",
          offset: "optional previous next_offset",
        },
        run: async (args, ctx) => {
          const processId = String(args.process_id ?? "");
          const offset =
            args.offset === undefined ? undefined : Number(args.offset);
          return this.terminal.read(processId, ctx.user.sub, offset);
        },
      },
      {
        name: "wait_process",
        description:
          "Wait briefly for a managed process to exit, then return its status and buffered output.",
        params: {
          process_id: "id returned by start_process",
          timeout_ms: "optional wait from 0 to 20000 milliseconds",
        },
        run: async (args, ctx) =>
          this.terminal.wait(
            String(args.process_id ?? ""),
            ctx.user.sub,
            args.timeout_ms === undefined ? undefined : Number(args.timeout_ms),
          ),
      },
      {
        name: "stop_process",
        description: "Stop a managed process and its child process tree.",
        params: { process_id: "id returned by start_process" },
        run: async (args, ctx) => {
          const processId = String(args.process_id ?? "");
          await this.logAction(ctx, "stop_process", { processId });
          return this.terminal.stop(processId, ctx.user.sub);
        },
      },
    ];
  }

  private memoryTools(): AgentTool[] {
    return [
      {
        name: "remember",
        description:
          "Save a fact to persistent memory so you recall it in future sessions.",
        params: { note: "the fact to remember" },
        run: async (args, ctx) => {
          await this.memory.save(ctx.user.sub, String(args.note ?? ""));
          return "remembered";
        },
      },
      {
        name: "recall",
        description: "List facts saved in persistent memory.",
        params: {},
        run: async (_a, ctx) => {
          const m = await this.memory.recent(ctx.user.sub);
          return m.length
            ? m.map((x) => "- " + x.content).join("\n")
            : "no memories";
        },
      },
    ];
  }

  private planTools(): AgentTool[] {
    return [
      {
        name: "set_plan",
        description:
          "Set a step-by-step plan for a multi-step goal. Call this first for non-trivial goals.",
        params: { steps: "array of short step descriptions" },
        run: async (args, ctx) => {
          const steps = Array.isArray(args.steps)
            ? (args.steps as unknown[]).map(String)
            : [];
          ctx.emit("agent.plan", {
            steps: steps.map((text) => ({ text, done: false })),
          });
          return `plan set with ${steps.length} step(s)`;
        },
      },
      {
        name: "update_plan",
        description: "Mark a plan step as done (0-based index).",
        params: { index: "step index", done: "true/false" },
        run: async (args, ctx) => {
          ctx.emit("agent.plan_update", {
            index: Number(args.index ?? 0),
            done: args.done !== false,
          });
          return `step ${Number(args.index ?? 0)} updated`;
        },
      },
      {
        name: "read_many_files",
        description:
          "Read several files at once. Returns each prefixed by its path.",
        params: { paths: "array of file paths" },
        run: async (args, ctx) => {
          const g = this.fsEnabled()
            ? null
            : "error: filesystem tools are disabled";
          if (g) return g;
          const paths = Array.isArray(args.paths)
            ? (args.paths as unknown[]).map(String)
            : [];
          await this.logAction(ctx, "read_many_files", { count: paths.length });
          const parts: string[] = [];
          for (const p of paths.slice(0, 20)) {
            try {
              const resolved = this.resolve(ctx, p);
              parts.push(
                `=== ${p} ===\n${(await readFile(resolved, "utf8")).slice(0, 20000)}`,
              );
            } catch (e) {
              parts.push(`=== ${p} ===\nerror: ${(e as Error).message}`);
            }
          }
          return parts.join("\n\n");
        },
      },
    ];
  }

  private projectTools(): AgentTool[] {
    const guard = (): string | null =>
      this.fsEnabled() ? null : "error: filesystem tools are disabled";
    type File = { p: string; c: string };
    const templates: Record<string, (n: string) => File[]> = {
      node: (n) => [
        {
          p: "package.json",
          c:
            JSON.stringify(
              {
                name: n,
                version: "0.1.0",
                type: "module",
                scripts: { start: "node src/index.js" },
              },
              null,
              2,
            ) + "\n",
        },
        { p: "src/index.js", c: `console.log('hello from ${n}');\n` },
        { p: "README.md", c: `# ${n}\n` },
        { p: ".gitignore", c: "node_modules/\n" },
      ],
      python: (n) => [
        {
          p: "pyproject.toml",
          c: `[project]\nname = "${n}"\nversion = "0.1.0"\n`,
        },
        {
          p: "main.py",
          c: `def main():\n    print("hello from ${n}")\n\n\nif __name__ == "__main__":\n    main()\n`,
        },
        { p: "README.md", c: `# ${n}\n` },
        { p: ".gitignore", c: "__pycache__/\n.venv/\n" },
      ],
      go: (n) => [
        { p: "go.mod", c: `module ${n}\n\ngo 1.22\n` },
        {
          p: "main.go",
          c: `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello from ${n}")\n}\n`,
        },
        { p: "README.md", c: `# ${n}\n` },
      ],
      static: (n) => [
        {
          p: "index.html",
          c: `<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>${n}</title><link rel="stylesheet" href="style.css"></head>\n<body><h1>${n}</h1><script src="script.js"></script></body>\n</html>\n`,
        },
        {
          p: "style.css",
          c: "body { font-family: system-ui; margin: 2rem; }\n",
        },
        { p: "script.js", c: `console.log('${n}');\n` },
        { p: "README.md", c: `# ${n}\n` },
      ],
      empty: (n) => [
        { p: "README.md", c: `# ${n}\n` },
        { p: ".gitignore", c: "" },
      ],
    };
    return [
      {
        name: "create_project",
        description: `Scaffold a new project. type one of: ${Object.keys(templates).join(", ")}.`,
        params: {
          path: "directory to create the project in",
          type: "project type",
          name: "optional project name",
        },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = this.resolve(ctx, String(args.path ?? ""));
          if (!path) return "error: path required";
          const type = String(args.type ?? "node");
          const name = String(args.name ?? (basename(path) || "app"));
          const make = (templates[type] ?? templates.node) as (
            n: string,
          ) => File[];
          await this.logAction(ctx, "create_project", { path, type, name });
          try {
            const baseDisplay = String(args.path ?? "")
              .replace(/\\/g, "/")
              .replace(/\/$/, "");
            const edits = make(name).map((file) => ({
              path: join(path, file.p),
              displayPath: `${baseDisplay}/${file.p}`,
              content: file.c,
            }));
            for (const edit of edits)
              this.assertNotWorkspaceRoot(ctx, edit.path);
            return await this.patches.apply(edits, ctx);
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: "apply_patch",
        description:
          "Atomically apply multiple file edits with a rollback checkpoint. Every edit is validated before any file changes. Use {path, content} or {path, find, replace, expectedMatches?, replaceAll?}.",
        params: { edits: "array of edit objects" },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const edits = Array.isArray(args.edits)
            ? (args.edits as Array<Record<string, unknown>>)
            : [];
          await this.logAction(ctx, "apply_patch", { files: edits.length });
          const resolved = [];
          for (const e of edits.slice(0, 30)) {
            const requestedPath = String(e.path ?? "");
            if (!requestedPath) {
              return "PATCH REJECTED: every edit requires a path";
            }
            try {
              const path = this.resolve(ctx, requestedPath);
              this.assertNotWorkspaceRoot(ctx, path);
              resolved.push({
                path,
                displayPath: requestedPath.replace(/\\/g, "/"),
                content:
                  e.content !== undefined ? String(e.content) : undefined,
                find: e.find !== undefined ? String(e.find) : undefined,
                replace:
                  e.replace !== undefined ? String(e.replace) : undefined,
                expectedMatches:
                  e.expectedMatches !== undefined
                    ? Number(e.expectedMatches)
                    : undefined,
                replaceAll: e.replaceAll === true,
              });
            } catch (err) {
              return `PATCH REJECTED: ${requestedPath}: ${(err as Error).message}`;
            }
          }
          return this.patches.apply(resolved, ctx);
        },
      },
      {
        name: "rollback_patch",
        description:
          "Restore every file changed by a previous atomic patch in this run. Refuses if a file changed after that patch.",
        params: { patch_id: "patchId returned by apply_patch" },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const patchId = String(args.patch_id ?? "").trim();
          if (!patchId) return "error: patch_id is required";
          await this.logAction(ctx, "rollback_patch", { patchId });
          return this.patches.rollback(patchId, ctx);
        },
      },
    ];
  }

  private codeTools(): AgentTool[] {
    const guard = (ctx: ToolCtx): string | null => {
      if (!this.fsEnabled()) return "error: filesystem tools are disabled";
      if (!ctx.cwd) return "error: open a project folder first";
      return null;
    };
    return [
      {
        name: "project_map",
        description:
          "Build or reuse the code index and return the architecture, languages, manifests, directories and key symbols. Use before exploring an unfamiliar repository.",
        params: {},
        run: async (_args, ctx) => {
          const error = guard(ctx);
          if (error) return error;
          await this.logAction(ctx, "project_map", { cwd: ctx.cwd });
          return this.codeIndex.projectMap(ctx.cwd as string);
        },
      },
      {
        name: "code_search",
        description:
          "Search the indexed project by symbol, file, feature or imported dependency. More precise than scanning every file.",
        params: {
          query: "symbol, feature, route, model, filename or dependency",
          kind: 'optional: "all", "symbols", "files", "imports", "calls" or "references"',
        },
        run: async (args, ctx) => {
          const error = guard(ctx);
          if (error) return error;
          const query = String(args.query ?? "");
          const kind = String(args.kind ?? "all");
          await this.logAction(ctx, "code_search", { query, kind });
          return this.codeIndex.search(ctx.cwd as string, query, kind);
        },
      },
      {
        name: "symbol_graph",
        description:
          "Show a symbol's definitions, callers, references, outgoing calls and defining-file dependencies. Use before changing a shared or public symbol.",
        params: { symbol: "function, class, method or exported symbol name" },
        run: async (args, ctx) => {
          const error = guard(ctx);
          if (error) return error;
          const symbol = String(args.symbol ?? "");
          await this.logAction(ctx, "symbol_graph", { symbol });
          return this.codeIndex.symbolGraph(ctx.cwd as string, symbol);
        },
      },
      {
        name: "verify_project",
        description:
          "Detect and run the repository's existing typecheck, tests and lint commands. Does not install dependencies or access the network.",
        params: {},
        run: async (_args, ctx) => {
          const error = guard(ctx);
          if (error) return error;
          await this.logAction(ctx, "verify_project", { cwd: ctx.cwd });
          ctx.emit("agent.verification_start", { cwd: ctx.cwd });
          const result = await this.verification.verify(
            ctx.cwd as string,
            ctx.cancelSignal,
          );
          ctx.emit("agent.verification_result", {
            passed: result.startsWith("VERIFICATION PASSED"),
            result,
          });
          return result;
        },
      },
    ];
  }

  private static readonly SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    ".turbo",
    "cache",
  ]);

  private async walk(
    dir: string,
    depth: number,
    fn: (path: string) => Promise<void>,
  ): Promise<void> {
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
    const guard = (): string | null =>
      this.fsEnabled() ? null : "error: filesystem tools are disabled";
    return [
      {
        name: "search_files",
        description:
          "Recursively search for text inside files under a directory. Returns matches as path:line.",
        params: { dir: "directory to search", query: "text to find" },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const dir = this.resolve(ctx, String(args.dir ?? "."));
          const query = String(args.query ?? "");
          if (!query) return "error: empty query";
          await this.logAction(ctx, "search_files", { dir, query });
          const hits: string[] = [];
          await this.walk(dir, 0, async (path) => {
            if (hits.length >= 80) return;
            try {
              const st = await stat(path);
              if (st.size > 2_000_000) return;
              const lines = (await readFile(path, "utf8")).split("\n");
              for (let i = 0; i < lines.length && hits.length < 80; i++) {
                if (lines[i]!.includes(query))
                  hits.push(
                    `${path}:${i + 1}: ${lines[i]!.trim().slice(0, 160)}`,
                  );
              }
            } catch {
              /* binary / unreadable */
            }
          });
          return hits.length ? hits.join("\n") : "no matches";
        },
      },
      {
        name: "find_files",
        description:
          'Recursively find files by name glob (e.g. "*.ts", "package.json").',
        params: { dir: "directory to search", pattern: "filename glob" },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const dir = this.resolve(ctx, String(args.dir ?? "."));
          const pattern = String(args.pattern ?? "*");
          await this.logAction(ctx, "find_files", { dir, pattern });
          const re = new RegExp(
            "^" +
              pattern
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, ".*")
                .replace(/\?/g, ".") +
              "$",
            "i",
          );
          const out: string[] = [];
          await this.walk(dir, 0, async (path) => {
            if (out.length >= 150) return;
            if (re.test(path.split(/[/\\]/).pop() ?? "")) out.push(path);
          });
          return out.length ? out.join("\n") : "no files";
        },
      },
      {
        name: "web_fetch",
        description:
          "HTTP GET a public URL and return the response text (read-only). Internal/private hosts are blocked.",
        params: { url: "the URL to fetch" },
        run: async (args, ctx) => {
          let url = String(args.url ?? "");
          await this.logAction(ctx, "web_fetch", { url });
          try {
            // SSRF guard: follow redirects manually, validating EVERY hop's host
            // (a 302 to 169.254.169.254 would otherwise bypass a one-shot check).
            for (let hop = 0; ; hop++) {
              const blocked = await this.assertPublicUrl(url);
              if (blocked) return blocked;
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 15000);
              const res = await fetch(url, {
                signal: ctrl.signal,
                redirect: "manual",
                headers: { "user-agent": "NeurionAgent/1.0" },
              });
              clearTimeout(t);
              const loc = res.headers.get("location");
              if (res.status >= 300 && res.status < 400 && loc) {
                if (hop >= 5) return "error: too many redirects";
                url = new URL(loc, url).toString();
                continue;
              }
              const text = await res.text();
              return `HTTP ${res.status}\n${text.slice(0, 50000)}`;
            }
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: "stat_path",
        description:
          "Get info about a file or directory (size, type, modified time).",
        params: { path: "file or directory path" },
        run: async (args, ctx) => {
          try {
            const s = await stat(this.resolve(ctx, String(args.path ?? "")));
            return JSON.stringify({
              type: s.isDirectory() ? "dir" : "file",
              sizeBytes: s.size,
              modified: s.mtime.toISOString(),
            });
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: "make_dir",
        description: "Create a directory (and parents).",
        params: { path: "directory path" },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = this.resolve(ctx, String(args.path ?? ""));
          this.assertNotWorkspaceRoot(ctx, path);
          await this.logAction(ctx, "make_dir", { path });
          try {
            await mkdir(path, { recursive: true });
            return `created ${path}`;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: "append_file",
        description:
          "Append text to the end of a file (creates it if missing).",
        params: { path: "file path", content: "text to append" },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = this.resolve(ctx, String(args.path ?? ""));
          await this.logAction(ctx, "append_file", {
            path,
            bytes: String(args.content ?? "").length,
          });
          try {
            const prev = await readFile(path, "utf8").catch(() => "");
            this.assertNotWorkspaceRoot(ctx, path);
            return await this.patches.apply(
              [
                {
                  path,
                  displayPath: String(args.path ?? "").replace(/\\/g, "/"),
                  content: prev + String(args.content ?? ""),
                },
              ],
              ctx,
            );
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: "move_path",
        description: "Move or rename a file or directory.",
        params: { from: "source path", to: "destination path" },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const from = this.resolve(ctx, String(args.from ?? ""));
          const to = this.resolve(ctx, String(args.to ?? ""));
          this.assertNotWorkspaceRoot(ctx, from);
          this.assertNotWorkspaceRoot(ctx, to);
          await this.logAction(ctx, "move_path", { from, to });
          try {
            await rename(from, to);
            return `moved ${from} -> ${to}`;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: "delete_path",
        description: "Delete a file or directory (recursive).",
        params: { path: "path to delete" },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = this.resolve(ctx, String(args.path ?? ""));
          this.assertNotWorkspaceRoot(ctx, path);
          await this.logAction(ctx, "delete_path", { path });
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
        name: "get_credits",
        description: "Get the user's current internal credit balance.",
        params: {},
        run: async (_a, ctx) =>
          `balance = ${await this.credits.getBalance(ctx.user.sub)} credits`,
      },
      {
        name: "list_nodes",
        description: "List the compute nodes and how many are online.",
        params: {},
        run: async (_a, ctx) => {
          const nodes = await this.prisma.computeNode.findMany({
            where: { workspaceId: ctx.user.workspaceId },
          });
          return JSON.stringify({
            total: nodes.length,
            online: nodes.filter((n) => this.gateway.isOnline(n.id)).length,
            nodes: nodes.map((n) => ({
              name: n.name,
              status: this.gateway.isOnline(n.id) ? "ONLINE" : n.status,
              trust: n.trustLevel,
            })),
          });
        },
      },
      {
        name: "create_grid_job",
        description:
          "Run a distributed grid job on the network and return its result.",
        params: { type: '"echo.v1" or "embedding.v1"', text: "input text" },
        run: async (args, ctx) => {
          const type = String(args.type ?? "echo.v1");
          if (!["echo.v1", "embedding.v1"].includes(type))
            return `error: unknown job type ${type}`;
          let job;
          try {
            job = await this.jobs.create(ctx.user, type, {
              text: String(args.text ?? ""),
            } as never);
          } catch (e) {
            return `error creating job: ${(e as Error).message}`;
          }
          for (let i = 0; i < 40; i++) {
            const j = await this.prisma.job.findUnique({
              where: { id: job.id },
            });
            if (
              j &&
              ["REWARDED", "VERIFIED", "COMPLETED", "FAILED"].includes(j.status)
            ) {
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
    const guard = (): string | null =>
      this.fsEnabled()
        ? null
        : "error: filesystem tools are disabled (AGENT_FS_ENABLED=false)";
    return [
      {
        name: "read_file",
        description: "Read a text file from disk. Returns up to 60KB.",
        params: { path: "absolute or relative file path" },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = this.resolve(ctx, String(args.path ?? ""));
          await this.logAction(ctx, "read_file", { path });
          try {
            const content = await readFile(path, "utf8");
            return content.length > 60000
              ? content.slice(0, 60000) + "\n…[truncated]"
              : content;
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: "write_file",
        description:
          "Create or overwrite one text file atomically and create a rollback checkpoint.",
        params: { path: "file path", content: "full file content" },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = this.resolve(ctx, String(args.path ?? ""));
          await this.logAction(ctx, "write_file", {
            path,
            bytes: String(args.content ?? "").length,
          });
          try {
            this.assertNotWorkspaceRoot(ctx, path);
            return await this.patches.apply(
              [
                {
                  path,
                  displayPath: String(args.path ?? "").replace(/\\/g, "/"),
                  content: String(args.content ?? ""),
                },
              ],
              ctx,
            );
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: "edit_file",
        description:
          "Replace exactly one occurrence atomically. Use apply_patch with expectedMatches or replaceAll for multiple occurrences.",
        params: {
          path: "file path",
          find: "exact text to find",
          replace: "replacement text",
        },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = this.resolve(ctx, String(args.path ?? ""));
          const find = String(args.find ?? "");
          await this.logAction(ctx, "edit_file", { path });
          try {
            this.assertNotWorkspaceRoot(ctx, path);
            return await this.patches.apply(
              [
                {
                  path,
                  displayPath: String(args.path ?? "").replace(/\\/g, "/"),
                  find,
                  replace: String(args.replace ?? ""),
                  expectedMatches: 1,
                },
              ],
              ctx,
            );
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: "list_dir",
        description: "List the entries of a directory.",
        params: { path: "directory path" },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const path = this.resolve(ctx, String(args.path ?? "."));
          await this.logAction(ctx, "list_dir", { path });
          try {
            const entries = await readdir(path, { withFileTypes: true });
            return JSON.stringify(
              entries
                .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
                .slice(0, 300),
            );
          } catch (e) {
            return `error: ${(e as Error).message}`;
          }
        },
      },
      {
        name: "run_command",
        description:
          "Run a shell command on the machine and return its output. Use for builds, git, tests, scripts.",
        params: {
          command: "the shell command",
          cwd: "optional working directory",
        },
        run: async (args, ctx) => {
          const g = guard();
          if (g) return g;
          const command = String(args.command ?? "");
          const cwd = args.cwd
            ? this.resolve(ctx, String(args.cwd))
            : (ctx.cwd ?? process.cwd());
          await this.logAction(ctx, "run_command", { command, cwd });
          try {
            await stat(cwd).catch(() => undefined);
            const { stdout, stderr } = await pexec(command, {
              cwd,
              timeout: 30000,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
              signal: ctx.cancelSignal,
            });
            const out = `${stdout}${stderr}`.trim();
            return out ? out.slice(0, 6000) : "ok (no output)";
          } catch (e) {
            const err = e as {
              message: string;
              stdout?: string;
              stderr?: string;
            };
            return `error: ${err.message}\n${(err.stdout ?? "") + (err.stderr ?? "")}`.slice(
              0,
              6000,
            );
          }
        },
      },
    ];
  }
}
