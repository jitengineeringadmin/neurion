/**
 * Security test for per-request cwd confinement (Workspace agent). resolve() must
 * reject any path that escapes the opened folder when ctx.confine is set.
 * Run: pnpm --filter @neurion/api exec tsx scripts/confine-test.ts
 */
import "reflect-metadata";
import assert from "node:assert";
import { AgentToolsService } from "../src/agent/agent-tools.service";

const cfg = (env: Record<string, string> = {}) =>
  ({ get: (k: string) => env[k] }) as never;
// resolve() only touches this.config; the other deps are unused for path logic.
const audit = { log: async () => undefined } as never;
const svc = new AgentToolsService(
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  audit,
  cfg(),
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
);
const unsafeSvc = new AgentToolsService(
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  audit,
  cfg({ AGENT_FS_CONFINE_TO_CWD: "false" }),
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
);
const resolve = (ctx: never, p: string): string =>
  (svc as unknown as { resolve: (c: never, p: string) => string }).resolve(
    ctx,
    p,
  );
const unsafeResolve = (ctx: never, p: string): string =>
  (
    unsafeSvc as unknown as { resolve: (c: never, p: string) => string }
  ).resolve(ctx, p);

const CWD = process.platform === "win32" ? "C:/work/proj" : "/work/proj";
const OUT =
  process.platform === "win32" ? "C:/Windows/System32/evil.txt" : "/etc/passwd";
const confined = { cwd: CWD, confine: true } as never;
const free = { cwd: CWD, confine: false } as never;

let passed = 0,
  failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
}

test("confined: a relative path inside the folder is allowed", () => {
  const r = resolve(confined, "notes.txt");
  assert.ok(r.includes("proj"), r);
});
test("confined: a nested relative path is allowed", () => {
  resolve(confined, "src/deep/file.ts");
});
test("confined: an absolute path OUTSIDE the folder is rejected", () => {
  assert.throws(() => resolve(confined, OUT), /escapes the project directory/);
});
test("confined: ../ traversal escaping the folder is rejected", () => {
  assert.throws(
    () => resolve(confined, "../../../etc/passwd"),
    /escapes the project directory/,
  );
});
test("confined: a sibling folder is rejected", () => {
  assert.throws(
    () => resolve(confined, "../proj-evil/x.txt"),
    /escapes the project directory/,
  );
});
test("confined: the folder itself is allowed", () => {
  resolve(confined, ".");
});
test("default confinement rejects an outside path even when the request flag is false", () => {
  assert.throws(() => resolve(free, OUT), /escapes the project directory/);
});
test("explicit administrator opt-out allows an outside path", () => {
  const r = unsafeResolve(free, OUT);
  assert.equal(r, OUT);
});

void (async () => {
  const ctx = {
    cwd: CWD,
    confine: false,
    user: { sub: "test-user" },
    emit: () => undefined,
    depth: 0,
  } as never;
  const readMany = svc.tools().find((tool) => tool.name === "read_many_files");
  const applyPatch = svc.tools().find((tool) => tool.name === "apply_patch");
  try {
    const result = await readMany?.run({ paths: [OUT] }, ctx);
    assert.match(result ?? "", /escapes the project directory/);
    passed++;
    console.log("  ok   read_many_files applies confinement to every path");
  } catch (error) {
    failed++;
    console.error(
      `  FAIL read_many_files applies confinement to every path\n       ${(error as Error).message}`,
    );
  }
  try {
    const result = await applyPatch?.run(
      { edits: [{ path: OUT, content: "blocked" }] },
      ctx,
    );
    assert.match(result ?? "", /escapes the project directory/);
    passed++;
    console.log("  ok   apply_patch applies confinement to every edit");
  } catch (error) {
    failed++;
    console.error(
      `  FAIL apply_patch applies confinement to every edit\n       ${(error as Error).message}`,
    );
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
