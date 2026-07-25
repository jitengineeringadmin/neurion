import { Injectable } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { AgentRunService } from "./agent-run.service";

interface CheckpointFile {
  path: string;
  displayPath: string;
  existed: boolean;
  before: string;
}

interface PatchCheckpoint {
  patchId: string;
  files: CheckpointFile[];
}

export interface AgentReviewResult {
  verdict: "pass" | "changes_required" | "unknown";
  summary: string;
  issues: string[];
  raw?: string;
}

@Injectable()
export class AgentReviewService {
  constructor(private readonly runs: AgentRunService) {}

  async buildContext(
    runId: string,
    cwd: string,
  ): Promise<{ files: number; checkpoints: number; diff: string }> {
    const artifacts = await this.runs.patchArtifacts(runId);
    const rolledBack = new Set<string>();
    for (const artifact of artifacts) {
      if (artifact.kind !== "patch-rollback") continue;
      try {
        const value = JSON.parse(artifact.content) as { patchId?: string };
        if (value.patchId) rolledBack.add(value.patchId);
      } catch {
        // Ignore malformed historical metadata; checkpoints remain independently valid.
      }
    }

    const originals = new Map<string, CheckpointFile>();
    let checkpoints = 0;
    for (const artifact of artifacts) {
      if (artifact.kind !== "patch-checkpoint") continue;
      try {
        const checkpoint = JSON.parse(artifact.content) as PatchCheckpoint;
        if (!checkpoint.patchId || rolledBack.has(checkpoint.patchId)) continue;
        checkpoints++;
        for (const file of checkpoint.files ?? []) {
          if (!originals.has(file.path)) originals.set(file.path, file);
        }
      } catch {
        // A corrupt checkpoint cannot be trusted as review input.
      }
    }

    const root = resolve(cwd);
    const sections: string[] = [];
    for (const snapshot of originals.values()) {
      const full = resolve(snapshot.path);
      if (full !== root && !full.startsWith(root + sep)) continue;
      const after = await readFile(full, "utf8").catch(() => "");
      if (after === snapshot.before) continue;
      sections.push(this.compactDiff(snapshot.displayPath, snapshot.before, after));
    }
    const cap = 48_000;
    const joined = sections.join("\n\n");
    return {
      files: sections.length,
      checkpoints,
      diff:
        joined.length > cap
          ? `${joined.slice(0, cap)}\n\n[review diff truncated]`
          : joined,
    };
  }

  parse(raw: string, diff = ""): AgentReviewResult {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return {
        verdict: "unknown",
        summary: "Reviewer returned an unreadable result.",
        issues: [],
        raw,
      };
    }
    try {
      const value = JSON.parse(raw.slice(start, end + 1)) as {
        verdict?: unknown;
        summary?: unknown;
        issues?: unknown;
      };
      const verdict = String(value.verdict ?? "").toLowerCase();
      let normalized: AgentReviewResult["verdict"] = verdict === "pass"
        ? "pass"
        : verdict === "changes_required"
          ? "changes_required"
          : "unknown";
      const issues = Array.isArray(value.issues)
        ? value.issues
            .map((issue) => {
              if (!issue || typeof issue !== "object") return null;
              const item = issue as Record<string, unknown>;
              const evidence = String(item.evidence ?? "").trim();
              const problem = String(item.problem ?? "").trim();
              if (!problem || evidence.length < 3 || !diff.includes(evidence))
                return null;
              const location = [item.path, item.line]
                .filter((part) => part !== undefined && String(part).trim())
                .join(":");
              return `${location ? `${location} ` : ""}${problem} Evidence: ${evidence}`;
            })
            .filter((issue): issue is string => Boolean(issue))
            .slice(0, 10)
        : [];
      let summary = String(value.summary ?? "No review summary.").slice(0, 4_000);
      if (normalized === "changes_required" && issues.length === 0) {
        normalized = "pass";
        summary = "No grounded blocking issue was found in the supplied diff.";
      }
      return {
        verdict: normalized,
        summary,
        issues,
        raw,
      };
    } catch {
      return {
        verdict: "unknown",
        summary: "Reviewer returned invalid JSON.",
        issues: [],
        raw,
      };
    }
  }

  private compactDiff(path: string, before: string, after: string): string {
    const oldLines = before.split(/\r?\n/);
    const newLines = after.split(/\r?\n/);
    let prefix = 0;
    while (
      prefix < oldLines.length &&
      prefix < newLines.length &&
      oldLines[prefix] === newLines[prefix]
    )
      prefix++;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] ===
        newLines[newLines.length - 1 - suffix]
    )
      suffix++;
    const contextStart = Math.max(0, prefix - 3);
    const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
    const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
    const removed = oldLines.slice(contextStart, oldEnd).slice(0, 240);
    const added = newLines.slice(contextStart, newEnd).slice(0, 240);
    return [
      `FILE ${path}`,
      `@@ -${contextStart + 1},${removed.length} +${contextStart + 1},${added.length} @@`,
      ...removed.map((line) => `- ${line}`),
      ...added.map((line) => `+ ${line}`),
      oldEnd - contextStart > removed.length || newEnd - contextStart > added.length
        ? "[file diff truncated]"
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}
