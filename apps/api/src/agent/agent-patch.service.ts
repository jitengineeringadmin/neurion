import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AgentCodeIndexService } from "./agent-code-index.service";
import { AgentRunService } from "./agent-run.service";
import { ToolCtx } from "./agent.types";

export interface ResolvedPatchEdit {
  path: string;
  displayPath: string;
  content?: string;
  find?: string;
  replace?: string;
  expectedMatches?: number;
  replaceAll?: boolean;
}

interface PatchSnapshot {
  path: string;
  displayPath: string;
  existed: boolean;
  before: string;
  beforeHash: string | null;
  afterHash: string;
}

interface PatchCheckpoint {
  version: 1;
  patchId: string;
  cwd?: string;
  createdAt: string;
  files: PatchSnapshot[];
}

interface PreparedFile extends PatchSnapshot {
  after: string;
  tempPath: string;
  backupPath: string;
  committed: boolean;
}

@Injectable()
export class AgentPatchService {
  constructor(
    private readonly config: ConfigService,
    private readonly runs: AgentRunService,
    private readonly codeIndex: AgentCodeIndexService,
  ) {}

  async apply(edits: ResolvedPatchEdit[], ctx: ToolCtx): Promise<string> {
    if (!edits.length) return "error: patch contains no edits";
    if (edits.length > 30) return "error: patch is limited to 30 edits";

    const patchId = randomUUID();
    let prepared: PreparedFile[];
    try {
      prepared = await this.prepare(edits, patchId);
    } catch (error) {
      return `PATCH REJECTED: ${(error as Error).message}`;
    }
    if (!prepared.length) return "NO CHANGES: patch matched the current files";

    const checkpoint: PatchCheckpoint = {
      version: 1,
      patchId,
      cwd: ctx.cwd,
      createdAt: new Date().toISOString(),
      files: prepared.map(
        ({ path, displayPath, existed, before, beforeHash, afterHash }) => ({
          path,
          displayPath,
          existed,
          before,
          beforeHash,
          afterHash,
        }),
      ),
    };
    const payload = JSON.stringify(checkpoint);
    const artifactCap = Math.max(
      64_000,
      Number(this.config.get("AGENT_ARTIFACT_MAX_BYTES") ?? 1_000_000),
    );
    const checkpointCap = Math.min(
      artifactCap - 2_000,
      Math.max(
        32_000,
        Number(this.config.get("AGENT_PATCH_CHECKPOINT_MAX_BYTES") ?? 750_000),
      ),
    );
    if (Buffer.byteLength(payload, "utf8") > checkpointCap) {
      await this.cleanupPrepared(prepared);
      return `PATCH REJECTED: rollback checkpoint exceeds ${checkpointCap} bytes; split the change into smaller patches`;
    }

    try {
      await this.commit(prepared);
      if (ctx.runId) {
        await this.runs.saveArtifact(
          ctx.runId,
          undefined,
          "patch-checkpoint",
          payload,
          {
            patchId,
            files: prepared.map((file) => file.displayPath),
          },
        );
      }
      await this.removeBackups(prepared);
      if (ctx.cwd) this.codeIndex.invalidate(ctx.cwd);
      return [
        "PATCH APPLIED",
        `patchId: ${patchId}`,
        `files: ${prepared.map((file) => file.displayPath).join(", ")}`,
        `rollback: rollback_patch({"patch_id":"${patchId}"})`,
      ].join("\n");
    } catch (error) {
      await this.rollbackCommit(prepared);
      return `PATCH FAILED AND ROLLED BACK: ${(error as Error).message}`;
    } finally {
      await this.cleanupPrepared(prepared);
    }
  }

  async rollback(patchId: string, ctx: ToolCtx): Promise<string> {
    if (!ctx.runId) return "error: rollback requires an active agent run";
    const artifact = await this.runs.findPatchCheckpoint(ctx.runId, patchId);
    if (!artifact) return `error: patch checkpoint ${patchId} was not found`;

    let checkpoint: PatchCheckpoint;
    try {
      checkpoint = JSON.parse(artifact.content) as PatchCheckpoint;
    } catch {
      return `error: patch checkpoint ${patchId} is corrupt`;
    }
    if (checkpoint.version !== 1 || checkpoint.patchId !== patchId)
      return `error: invalid patch checkpoint ${patchId}`;

    const transactionId = randomUUID();
    const states: Array<{
      snapshot: PatchSnapshot;
      currentExists: boolean;
      tempPath?: string;
      backupPath: string;
      committed: boolean;
    }> = [];
    try {
      for (const snapshot of checkpoint.files) {
        const current = await this.readExisting(snapshot.path);
        const currentHash = current.exists ? this.hash(current.content) : null;
        if (currentHash !== snapshot.afterHash) {
          throw new Error(
            `${snapshot.displayPath} changed after patch ${patchId}; refusing to overwrite newer work`,
          );
        }
        const backupPath = join(
          dirname(snapshot.path),
          `.${basename(snapshot.path)}.neurion-${transactionId}.rollback-current`,
        );
        let tempPath: string | undefined;
        if (snapshot.existed) {
          tempPath = join(
            dirname(snapshot.path),
            `.${basename(snapshot.path)}.neurion-${transactionId}.rollback-temp`,
          );
          await writeFile(tempPath, snapshot.before, "utf8");
        }
        states.push({
          snapshot,
          currentExists: current.exists,
          tempPath,
          backupPath,
          committed: false,
        });
      }

      for (const state of states) {
        if (state.currentExists)
          await rename(state.snapshot.path, state.backupPath);
        if (state.tempPath) await rename(state.tempPath, state.snapshot.path);
        state.committed = true;
      }
      for (const state of states)
        await rm(state.backupPath, { force: true }).catch(() => undefined);
      await this.runs.saveArtifact(
        ctx.runId,
        undefined,
        "patch-rollback",
        JSON.stringify({
          patchId,
          files: checkpoint.files.map((f) => f.displayPath),
        }),
        { patchId },
      );
      if (ctx.cwd) this.codeIndex.invalidate(ctx.cwd);
      return `PATCH ROLLED BACK: ${patchId}\nfiles: ${checkpoint.files.map((file) => file.displayPath).join(", ")}`;
    } catch (error) {
      for (const state of [...states].reverse()) {
        if (!state.committed) continue;
        await rm(state.snapshot.path, { force: true }).catch(() => undefined);
        if (state.currentExists)
          await rename(state.backupPath, state.snapshot.path).catch(
            () => undefined,
          );
      }
      return `ROLLBACK REFUSED OR FAILED: ${(error as Error).message}`;
    } finally {
      for (const state of states) {
        if (state.tempPath)
          await rm(state.tempPath, { force: true }).catch(() => undefined);
        await rm(state.backupPath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async prepare(
    edits: ResolvedPatchEdit[],
    patchId: string,
  ): Promise<PreparedFile[]> {
    const grouped = new Map<
      string,
      { displayPath: string; edits: ResolvedPatchEdit[] }
    >();
    for (const edit of edits) {
      const entry = grouped.get(edit.path) ?? {
        displayPath: edit.displayPath,
        edits: [],
      };
      entry.edits.push(edit);
      grouped.set(edit.path, entry);
    }

    const prepared: PreparedFile[] = [];
    for (const [path, group] of grouped) {
      const original = await this.readExisting(path);
      let after = original.content;
      for (const edit of group.edits) {
        if (edit.content !== undefined) {
          after = edit.content;
          continue;
        }
        if (!original.exists && !after)
          throw new Error(`${group.displayPath} does not exist`);
        const find = edit.find ?? "";
        if (!find) throw new Error(`${group.displayPath}: find text is empty`);
        const matches = after.split(find).length - 1;
        if (matches === 0)
          throw new Error(`${group.displayPath}: find text was not found`);
        const expected = edit.replaceAll
          ? matches
          : Math.max(1, Number(edit.expectedMatches ?? 1));
        if (matches !== expected) {
          throw new Error(
            `${group.displayPath}: expected ${expected} match(es), found ${matches}`,
          );
        }
        after = after.split(find).join(edit.replace ?? "");
      }
      if (after === original.content && original.exists) continue;
      const token = patchId.replace(/-/g, "");
      prepared.push({
        path,
        displayPath: group.displayPath,
        existed: original.exists,
        before: original.content,
        beforeHash: original.exists ? this.hash(original.content) : null,
        after,
        afterHash: this.hash(after),
        tempPath: join(
          dirname(path),
          `.${basename(path)}.neurion-${token}.tmp`,
        ),
        backupPath: join(
          dirname(path),
          `.${basename(path)}.neurion-${token}.bak`,
        ),
        committed: false,
      });
    }
    return prepared;
  }

  private async commit(files: PreparedFile[]): Promise<void> {
    for (const file of files) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.tempPath, file.after, "utf8");
    }
    for (const file of files) {
      if (file.existed) await rename(file.path, file.backupPath);
      try {
        await rename(file.tempPath, file.path);
        file.committed = true;
      } catch (error) {
        if (file.existed)
          await rename(file.backupPath, file.path).catch(() => undefined);
        throw error;
      }
    }
  }

  private async rollbackCommit(files: PreparedFile[]): Promise<void> {
    for (const file of [...files].reverse()) {
      if (!file.committed) continue;
      await rm(file.path, { force: true }).catch(() => undefined);
      if (file.existed)
        await rename(file.backupPath, file.path).catch(() => undefined);
      file.committed = false;
    }
  }

  private async removeBackups(files: PreparedFile[]): Promise<void> {
    for (const file of files)
      await rm(file.backupPath, { force: true }).catch(() => undefined);
  }

  private async cleanupPrepared(files: PreparedFile[]): Promise<void> {
    for (const file of files) {
      await rm(file.tempPath, { force: true }).catch(() => undefined);
      if (!file.committed)
        await rm(file.backupPath, { force: true }).catch(() => undefined);
    }
  }

  private async readExisting(
    path: string,
  ): Promise<{ exists: boolean; content: string }> {
    try {
      return { exists: true, content: await readFile(path, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { exists: false, content: "" };
      throw error;
    }
  }

  private hash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}
