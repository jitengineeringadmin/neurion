/**
 * The checksum gate is the whole basis of accepting weights from a stranger, so
 * it is tested against a served file that is deliberately wrong — not only
 * against one that is right. A check that only ever sees valid input has never
 * been tested.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile } from "../src/ai/engine/download.util";

let passed = 0;
let failed = 0;
function ok(name: string): void {
  passed += 1;
  console.log(`  ok   ${name}`);
}
function bad(name: string, err: unknown): void {
  failed += 1;
  console.log(`  FAIL ${name}`);
  console.log(`       ${(err as Error)?.message ?? String(err)}`);
}
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(name, e);
  }
}
function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

const GOOD = Buffer.from("questi sono i pesi veri del modello");
const EVIL = Buffer.from("questi sono pesi avvelenati............");
const goodSha = createHash("sha256").update(GOOD).digest("hex");

async function main(): Promise<void> {
  // A peer that serves whatever it likes, which is the situation being defended
  // against: the bytes come from someone we have no reason to trust.
  let body = GOOD;
  const server = createServer((_req, res) => {
    res.setHeader("content-length", String(body.length));
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/weights.gguf`;
  const dir = mkdtempSync(join(tmpdir(), "neurion-hash-"));
  const out = join(dir, "weights.gguf");

  await check("the real file is accepted", async () => {
    body = GOOD;
    const n = await downloadFile(url, out, undefined, { sha256: goodSha });
    assert(n === GOOD.length, `expected ${GOOD.length} bytes, got ${n}`);
    assert(existsSync(out), "the file should be in place");
  });

  await check("a tampered file is refused", async () => {
    rmSync(out, { force: true });
    body = EVIL; // same name, same request — different bytes
    let threw = false;
    try {
      await downloadFile(url, out, undefined, { sha256: goodSha });
    } catch (e) {
      threw = true;
      assert(
        /checksum mismatch/i.test((e as Error).message),
        `expected a checksum error, got: ${(e as Error).message}`,
      );
    }
    assert(threw, "a poisoned file was accepted");
  });

  await check("a refused file is not left behind as installed", () => {
    // The rename happens only after the hash matches, so nothing must be there.
    assert(
      !existsSync(out),
      "the poisoned file was left in place and would load on the next start",
    );
    return Promise.resolve();
  });

  await check("without an expected hash nothing is checked", async () => {
    body = EVIL;
    const n = await downloadFile(url, out, undefined, {});
    assert(n === EVIL.length, "the file should have been written unchecked");
  });

  server.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
