import "reflect-metadata";
import assert from "node:assert";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentCodeIndexService } from "../src/agent/agent-code-index.service";
import { AgentPatchService } from "../src/agent/agent-patch.service";
import { AgentVerificationService } from "../src/agent/agent-verification.service";
import { AgentTerminalService } from "../src/agent/agent-terminal.service";
import {
  AgentToolValidationService,
  agentToolSchema,
} from "../src/agent/agent-tool-validation.service";
import { AgentReviewService } from "../src/agent/agent-review.service";
import { AgentOrchestratorService } from "../src/agent/agent-orchestrator.service";
import { AgentExecutionService } from "../src/agent/agent-execution.service";

const root = join(process.cwd(), `.tmp-agent-upgrade-${process.pid}`);
const config = {
  get: (key: string) =>
    key === "AGENT_VERIFY_TIMEOUT_MS" ? 30_000 : undefined,
} as never;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(error as Error).stack}`);
  }
}

void (async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "billing.ts"),
    [
      'import { roundMoney } from "./money";',
      "export interface Invoice { total: number }",
      "export function calculateTotal(items: number[]): number {",
      "  return roundMoney(items.reduce((sum, item) => sum + item, 0));",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "src", "money.ts"),
    "export const roundMoney = (value: number) => Math.round(value * 100) / 100;\n",
    "utf8",
  );
  await writeFile(
    join(root, "src", "checkout.ts"),
    [
      'import { calculateTotal } from "./billing";',
      "export const checkout = (prices: number[]) => calculateTotal(prices);",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "agent-upgrade-fixture",
      private: true,
      scripts: { typecheck: 'node -e "process.exit(0)"' },
    }),
    "utf8",
  );

  const index = new AgentCodeIndexService(config);
  await test("code index maps languages and exported symbols", async () => {
    const map = await index.projectMap(root);
    assert.match(map, /TypeScript/);
    assert.match(map, /calculateTotal/);
    assert.match(map, /package\.json/);
  });
  await test("code search finds a symbol and its source line", async () => {
    const result = await index.search(root, "calculateTotal", "symbols");
    assert.match(result, /src\/billing\.ts:3/);
    assert.match(result, /function/);
  });
  await test("code search indexes imported dependencies", async () => {
    const result = await index.search(root, "money", "imports");
    assert.match(result, /src\/billing\.ts/);
    assert.match(result, /\.\/money/);
  });
  await test("AST index finds calls and their owning symbol", async () => {
    const result = await index.search(root, "roundMoney", "calls");
    assert.match(result, /src\/billing\.ts:4/);
    assert.match(result, /call in calculateTotal/);
  });
  await test("symbol graph connects definitions, callers and callees", async () => {
    const result = await index.symbolGraph(root, "calculateTotal");
    assert.match(result, /Definitions:[\s\S]*src\/billing\.ts:3/);
    assert.match(result, /Callers:[\s\S]*src\/checkout\.ts:2/);
    assert.match(result, /Calls made by symbol:[\s\S]*roundMoney/);
  });

  const artifacts: Array<{
    content: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const runs = {
    saveArtifact: async (
      _runId: string,
      _stepId: string | undefined,
      kind: string,
      content: string,
      metadata?: Record<string, unknown>,
    ) => {
      if (kind === "patch-checkpoint") artifacts.push({ content, metadata });
      return { id: String(artifacts.length) };
    },
    findPatchCheckpoint: async (_runId: string, patchId: string) =>
      artifacts.find((artifact) => artifact.metadata?.patchId === patchId) ??
      null,
  } as never;
  const patches = new AgentPatchService(config, runs, index);
  const ctx = {
    cwd: root,
    runId: "test-run",
    user: { sub: "test-user" },
    emit: () => undefined,
    depth: 0,
  } as never;
  const first = join(root, "first.txt");
  const second = join(root, "second.txt");
  await writeFile(first, "alpha", "utf8");
  await writeFile(second, "beta", "utf8");

  await test("atomic patch changes all files and creates a checkpoint", async () => {
    const result = await patches.apply(
      [
        {
          path: first,
          displayPath: "first.txt",
          find: "alpha",
          replace: "ALPHA",
        },
        {
          path: second,
          displayPath: "second.txt",
          content: "BETA",
        },
      ],
      ctx,
    );
    assert.match(result, /^PATCH APPLIED/);
    assert.equal(await readFile(first, "utf8"), "ALPHA");
    assert.equal(await readFile(second, "utf8"), "BETA");
    assert.equal(artifacts.length, 1);
  });

  await test("invalid multi-file patch leaves every file untouched", async () => {
    const result = await patches.apply(
      [
        {
          path: first,
          displayPath: "first.txt",
          content: "should-not-stick",
        },
        {
          path: second,
          displayPath: "second.txt",
          find: "missing",
          replace: "x",
        },
      ],
      ctx,
    );
    assert.match(result, /^PATCH REJECTED/);
    assert.equal(await readFile(first, "utf8"), "ALPHA");
    assert.equal(await readFile(second, "utf8"), "BETA");
  });

  await test("rollback restores every file in the atomic patch", async () => {
    const checkpoint = artifacts[0];
    const patchId = String(checkpoint?.metadata?.patchId);
    const result = await patches.rollback(patchId, ctx);
    assert.match(result, /^PATCH ROLLED BACK/);
    assert.equal(await readFile(first, "utf8"), "alpha");
    assert.equal(await readFile(second, "utf8"), "beta");
  });

  await test("verification detects and executes the project check", async () => {
    const verifier = new AgentVerificationService(config);
    const result = await verifier.verify(root);
    assert.match(result, /^VERIFICATION PASSED/);
    assert.match(result, /run typecheck/);
  });

  const terminal = new AgentTerminalService(config);
  await test("managed process can be started, waited and read", async () => {
    const started = await terminal.start(
      "node -e \"console.log('ready'); setTimeout(() => console.log('done'), 80)\"",
      root,
      ctx,
      5_000,
    );
    const processId = started.match(/process_id: ([^\s]+)/)?.[1];
    assert.ok(processId);
    const result = await terminal.wait(processId, "test-user", 5_000);
    assert.match(result, /PROCESS EXITED/);
    assert.match(result, /ready/);
    assert.match(result, /done/);
  });
  await test("managed process is isolated by user", async () => {
    const started = await terminal.start(
      'node -e "setTimeout(() => {}, 1000)"',
      root,
      ctx,
      5_000,
    );
    const processId = started.match(/process_id: ([^\s]+)/)?.[1];
    assert.ok(processId);
    assert.equal(
      terminal.read(processId, "other-user"),
      "error: process not found",
    );
    assert.match(
      await terminal.stop(processId, "test-user"),
      /PROCESS STOPPED/,
    );
  });
  await terminal.onModuleDestroy();

  const toolValidation = new AgentToolValidationService();
  const runCommandTool = {
    name: "run_command",
    description: "test",
    params: {},
    inputSchema: agentToolSchema("run_command"),
    run: async () => "ok",
  };
  await test("typed tool validation rejects missing required arguments", async () => {
    const result = toolValidation.validate(runCommandTool, {});
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /command is required/);
  });
  await test("typed tool validation repairs safe names and primitive types", async () => {
    const processTool = {
      ...runCommandTool,
      name: "wait_process",
      inputSchema: agentToolSchema("wait_process"),
    };
    const result = toolValidation.validate(processTool, {
      processId: "abc",
      timeout_ms: "5000",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, { process_id: "abc", timeout_ms: 5000 });
    assert.ok(result.repairs.length >= 2);
    assert.equal(
      toolValidation.resolveTool("WAIT-PROCESS", [processTool])?.name,
      "wait_process",
    );
  });
  await test("typed tool validation repairs apply_patch array arguments", async () => {
    const patchTool = {
      ...runCommandTool,
      name: "apply_patch",
      inputSchema: agentToolSchema("apply_patch"),
    };
    const result = toolValidation.validate(patchTool, [
      { path: "src/a.ts", content: "export {};" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, {
      edits: [{ path: "src/a.ts", content: "export {};" }],
    });
    assert.match(result.repairs.join(" "), /wrapped apply_patch/);
  });
  await test("code_search accepts the common symbol alias", async () => {
    const searchTool = {
      ...runCommandTool,
      name: "code_search",
      inputSchema: agentToolSchema("code_search"),
    };
    const result = toolValidation.validate(searchTool, {
      symbol: "calculateTotal",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, { query: "calculateTotal" });
  });
  const actionParser = Object.create(
    AgentOrchestratorService.prototype,
  ) as unknown as {
    parseAction: (text: string) => {
      tool?: string;
      args?: Record<string, unknown>;
      invalid?: string;
    };
  };
  await test("action parser accepts JSON5 single-quoted content", async () => {
    const result = actionParser.parseAction(
      `{ "tool": "edit_file", "args": { "path": "src/a.ts", "replace": 'line 1\\nline 2' } }`,
    );
    assert.equal(result.tool, "edit_file");
    assert.equal(result.args?.replace, "line 1\nline 2");
  });
  await test("action parser rejects multiple actions in one response", async () => {
    const result = actionParser.parseAction(
      `{"tool":"read_file","args":{"path":"a"}}\n{"final":"done"}`,
    );
    assert.match(result.invalid ?? "", /multiple actions/);
  });

  await test("review context is built from checkpointed file changes", async () => {
    const reviewFile = join(root, "review.ts");
    await writeFile(reviewFile, "export const value = 2;\n", "utf8");
    const reviewRuns = {
      patchArtifacts: async () => [
        {
          kind: "patch-checkpoint",
          createdAt: new Date(),
          content: JSON.stringify({
            patchId: "review-patch",
            files: [
              {
                path: reviewFile,
                displayPath: "review.ts",
                existed: true,
                before: "export const value = 1;\n",
              },
            ],
          }),
        },
      ],
    } as never;
    const reviewer = new AgentReviewService(reviewRuns);
    const context = await reviewer.buildContext("run", root);
    assert.equal(context.files, 1);
    assert.match(context.diff, /- export const value = 1/);
    assert.match(context.diff, /\+ export const value = 2/);
    assert.equal(
      reviewer.parse('{"verdict":"pass","summary":"ok","issues":[]}').verdict,
      "pass",
    );
    assert.equal(
      reviewer.parse(
        '{"verdict":"changes_required","summary":"claim","issues":["not grounded"]}',
        context.diff,
      ).verdict,
      "pass",
    );
    assert.equal(
      reviewer.parse(
        '{"verdict":"changes_required","summary":"claim","issues":[{"path":"review.ts","line":1,"problem":"wrong value","evidence":"export const value = 2"}]}',
        context.diff,
      ).verdict,
      "changes_required",
    );
  });

  await test("detached execution persists ordered events after returning", async () => {
    const persisted: Array<{ sequence: number; event: string }> = [];
    const detachedRuns = {
      active: async () => null,
      appendEvent: async (_runId: string, sequence: number, event: string) => {
        persisted.push({ sequence, event });
      },
      isCancelled: async () => false,
      cancel: async () => ({ id: "detached-run", status: "CANCELLED" }),
    } as never;
    const detachedOrchestrator = {
      createRun: async () => ({ id: "detached-run", status: "PENDING" }),
      run: async (_goal: string, runCtx: any) => {
        runCtx.emit("agent.run", { runId: "detached-run" });
        await new Promise((resolve) => setTimeout(resolve, 120));
        runCtx.emit("agent.final", { depth: 0, text: "done" });
        return "done";
      },
    } as never;
    const execution = new AgentExecutionService(
      detachedOrchestrator,
      detachedRuns,
      { denyRun: () => undefined } as never,
      { stopRun: async () => undefined } as never,
    );
    const startedAt = Date.now();
    const started = await execution.start(
      { sub: "test-user", workspaceId: "test-workspace" } as never,
      { goal: "detached test", cwd: root },
    );
    assert.equal(started.runId, "detached-run");
    assert.ok(
      Date.now() - startedAt < 80,
      "start should not await the agent loop",
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(
      persisted.map((event) => event.event),
      ["agent.start", "agent.run", "agent.final", "agent.done"],
    );
    assert.deepEqual(
      persisted.map((event) => event.sequence),
      [1, 2, 3, 4],
    );
    assert.equal(execution.isActive("detached-run"), false);
  });

  await test("cancelling a detached execution aborts inference and processes", async () => {
    let cancelled = false;
    let processStopped = false;
    let inferenceAborted = false;
    const cancelRuns = {
      active: async () => null,
      appendEvent: async () => undefined,
      isCancelled: async () => cancelled,
      cancel: async () => {
        cancelled = true;
        return { id: "cancel-run", status: "CANCELLED" };
      },
    } as never;
    const cancelOrchestrator = {
      createRun: async () => ({ id: "cancel-run", status: "PENDING" }),
      run: async (_goal: string, runCtx: any) =>
        new Promise<string>((_resolve, reject) => {
          runCtx.cancelSignal.addEventListener(
            "abort",
            () => {
              inferenceAborted = true;
              reject(new Error("Agent run cancelled."));
            },
            { once: true },
          );
        }),
    } as never;
    const execution = new AgentExecutionService(
      cancelOrchestrator,
      cancelRuns,
      { denyRun: () => undefined } as never,
      {
        stopRun: async () => {
          processStopped = true;
        },
      } as never,
    );
    const user = {
      sub: "cancel-user",
      workspaceId: "test-workspace",
    } as never;
    await execution.start(user, { goal: "cancel test", cwd: root });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await execution.cancel(user, "cancel-run");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(inferenceAborted, true);
    assert.equal(processStopped, true);
    assert.equal(execution.isActive("cancel-run"), false);
  });

  await rm(root, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(async (error) => {
  console.error(error);
  await rm(root, { recursive: true, force: true });
  process.exit(1);
});
