/**
 * Security test for per-request cwd confinement (Workspace agent). resolve() must
 * reject any path that escapes the opened folder when ctx.confine is set.
 * Run: pnpm --filter @neurion/api exec tsx scripts/confine-test.ts
 */
import 'reflect-metadata';
import assert from 'node:assert';
import { AgentToolsService } from '../src/agent/agent-tools.service';

const cfg = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as never;
// resolve() only touches this.config; the other deps are unused for path logic.
const svc = new AgentToolsService({} as never, {} as never, {} as never, {} as never, {} as never, cfg(), {} as never);
const resolve = (ctx: never, p: string): string => (svc as unknown as { resolve: (c: never, p: string) => string }).resolve(ctx, p);

const CWD = process.platform === 'win32' ? 'C:/work/proj' : '/work/proj';
const OUT = process.platform === 'win32' ? 'C:/Windows/System32/evil.txt' : '/etc/passwd';
const confined = { cwd: CWD, confine: true } as never;
const free = { cwd: CWD, confine: false } as never;

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${(e as Error).message}`); }
}

test('confined: a relative path inside the folder is allowed', () => {
  const r = resolve(confined, 'notes.txt');
  assert.ok(r.includes('proj'), r);
});
test('confined: a nested relative path is allowed', () => {
  resolve(confined, 'src/deep/file.ts');
});
test('confined: an absolute path OUTSIDE the folder is rejected', () => {
  assert.throws(() => resolve(confined, OUT), /escapes the project directory/);
});
test('confined: ../ traversal escaping the folder is rejected', () => {
  assert.throws(() => resolve(confined, '../../../etc/passwd'), /escapes the project directory/);
});
test('confined: a sibling folder is rejected', () => {
  assert.throws(() => resolve(confined, '../proj-evil/x.txt'), /escapes the project directory/);
});
test('confined: the folder itself is allowed', () => {
  resolve(confined, '.');
});
test('NOT confined (confine=false, env off): an absolute outside path passes through', () => {
  const r = resolve(free, OUT);
  assert.equal(r, OUT);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
