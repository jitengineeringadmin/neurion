import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { ToolCtx } from "./agent.types";

const execFileAsync = promisify(execFile);

type ProcessStatus = "RUNNING" | "EXITED" | "FAILED" | "STOPPED";

interface ProcessSession {
  id: string;
  userId: string;
  runId?: string;
  cwd: string;
  command: string;
  child: ChildProcessWithoutNullStreams;
  status: ProcessStatus;
  output: string;
  baseOffset: number;
  nextOffset: number;
  startedAt: Date;
  exitedAt?: Date;
  exitCode?: number | null;
  timer?: NodeJS.Timeout;
  emit: ToolCtx["emit"];
}

@Injectable()
export class AgentTerminalService implements OnModuleDestroy {
  private readonly sessions = new Map<string, ProcessSession>();

  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.status === "RUNNING")
        .map((session) => this.terminate(session)),
    );
  }

  async start(
    command: string,
    cwd: string,
    ctx: ToolCtx,
    requestedTimeoutMs?: number,
  ): Promise<string> {
    if (!command.trim()) return "error: command is required";
    const info = await stat(cwd).catch(() => null);
    if (!info?.isDirectory())
      return `error: working directory not found: ${cwd}`;
    this.cleanup();
    const maxConcurrent = Math.max(
      1,
      Number(this.config.get("AGENT_PROCESS_MAX_CONCURRENT") ?? 4),
    );
    const running = [...this.sessions.values()].filter(
      (session) =>
        session.userId === ctx.user.sub && session.status === "RUNNING",
    ).length;
    if (running >= maxConcurrent) {
      return `error: process limit reached (${maxConcurrent}); stop an existing process first`;
    }

    const configuredTimeout = Math.max(
      1_000,
      Number(this.config.get("AGENT_PROCESS_TIMEOUT_MS") ?? 900_000),
    );
    const timeoutMs = Math.min(
      1_800_000,
      Math.max(1_000, requestedTimeoutMs ?? configuredTimeout),
    );
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
      stdio: "pipe",
    });
    const session: ProcessSession = {
      id: randomUUID(),
      userId: ctx.user.sub,
      runId: ctx.runId,
      cwd,
      command,
      child,
      status: "RUNNING",
      output: "",
      baseOffset: 0,
      nextOffset: 0,
      startedAt: new Date(),
      emit: ctx.emit,
    };
    this.sessions.set(session.id, session);
    const append = (chunk: Buffer | string, stream: "stdout" | "stderr") => {
      const text = chunk.toString();
      this.append(session, text);
      session.emit("agent.process_output", {
        processId: session.id,
        stream,
        chunk: text.slice(-8_000),
        nextOffset: session.nextOffset,
      });
    };
    child.stdout.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk) => append(chunk, "stderr"));
    child.on("error", (error) => {
      this.append(session, `\n[process error: ${error.message}]\n`);
      if (session.status === "RUNNING") session.status = "FAILED";
    });
    child.on("close", (code) => {
      if (session.timer) clearTimeout(session.timer);
      session.exitCode = code;
      session.exitedAt = new Date();
      if (session.status === "RUNNING")
        session.status = code === 0 ? "EXITED" : "FAILED";
      session.emit("agent.process_status", this.summary(session));
    });
    session.timer = setTimeout(() => {
      if (session.status !== "RUNNING") return;
      this.append(
        session,
        `\n[process stopped after ${timeoutMs} ms timeout]\n`,
      );
      session.status = "STOPPED";
      void this.terminate(session);
    }, timeoutMs);
    session.timer.unref?.();
    ctx.emit("agent.process_status", this.summary(session));
    return this.format(session, 0, false);
  }

  read(processId: string, userId: string, offset?: number): string {
    const session = this.owned(processId, userId);
    if (!session) return "error: process not found";
    return this.format(session, offset, true);
  }

  async wait(
    processId: string,
    userId: string,
    requestedTimeoutMs?: number,
  ): Promise<string> {
    const session = this.owned(processId, userId);
    if (!session) return "error: process not found";
    const timeoutMs = Math.min(
      20_000,
      Math.max(0, requestedTimeoutMs ?? 10_000),
    );
    if (session.status === "RUNNING" && timeoutMs > 0) {
      await Promise.race([
        new Promise<void>((resolve) =>
          session.child.once("close", () => resolve()),
        ),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
    return this.format(session, undefined, true);
  }

  async stop(processId: string, userId: string): Promise<string> {
    const session = this.owned(processId, userId);
    if (!session) return "error: process not found";
    if (session.status !== "RUNNING")
      return this.format(session, undefined, true);
    session.status = "STOPPED";
    this.append(session, "\n[process stopped by agent]\n");
    await this.terminate(session);
    return this.format(session, undefined, true);
  }

  async stopRun(runId: string, userId: string): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter(
          (session) =>
            session.runId === runId &&
            session.userId === userId &&
            session.status === "RUNNING",
        )
        .map(async (session) => {
          session.status = "STOPPED";
          this.append(
            session,
            "\n[process stopped because the agent run ended]\n",
          );
          await this.terminate(session);
        }),
    );
  }

  private owned(processId: string, userId: string): ProcessSession | null {
    const session = this.sessions.get(processId);
    return session?.userId === userId ? session : null;
  }

  private append(session: ProcessSession, text: string): void {
    session.output += text;
    session.nextOffset += text.length;
    const maxChars = Math.max(
      32_000,
      Number(this.config.get("AGENT_PROCESS_MAX_OUTPUT_CHARS") ?? 1_000_000),
    );
    if (session.output.length > maxChars) {
      const removed = session.output.length - maxChars;
      session.output = session.output.slice(removed);
      session.baseOffset += removed;
    }
  }

  private summary(session: ProcessSession) {
    return {
      processId: session.id,
      status: session.status,
      pid: session.child.pid ?? null,
      exitCode: session.exitCode ?? null,
      cwd: session.cwd,
      startedAt: session.startedAt.toISOString(),
      exitedAt: session.exitedAt?.toISOString() ?? null,
      nextOffset: session.nextOffset,
    };
  }

  private format(
    session: ProcessSession,
    requestedOffset?: number,
    includeOutput = true,
  ): string {
    const offset = Math.max(
      session.baseOffset,
      Number.isFinite(requestedOffset)
        ? Number(requestedOffset)
        : session.baseOffset,
    );
    const output = includeOutput
      ? session.output.slice(Math.max(0, offset - session.baseOffset))
      : "";
    return [
      `PROCESS ${session.status}`,
      `process_id: ${session.id}`,
      `pid: ${session.child.pid ?? "unknown"}`,
      `exit_code: ${session.exitCode ?? "pending"}`,
      `cwd: ${session.cwd}`,
      `next_offset: ${session.nextOffset}`,
      requestedOffset !== undefined && requestedOffset < session.baseOffset
        ? `output_truncated_before: ${session.baseOffset}`
        : "",
      output ? `OUTPUT\n${output}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async terminate(session: ProcessSession): Promise<void> {
    if (session.timer) clearTimeout(session.timer);
    const pid = session.child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => session.child.kill());
    } else {
      session.child.kill("SIGTERM");
    }
  }

  private cleanup(): void {
    const retentionMs = Math.max(
      60_000,
      Number(this.config.get("AGENT_PROCESS_RETENTION_MS") ?? 1_800_000),
    );
    const cutoff = Date.now() - retentionMs;
    for (const [id, session] of this.sessions) {
      if (
        session.status !== "RUNNING" &&
        (session.exitedAt?.getTime() ?? session.startedAt.getTime()) < cutoff
      ) {
        this.sessions.delete(id);
      }
    }
  }
}
