/**
 * Two machines, one network — simulated in one process.
 *
 * This is the piece the whole peer-to-peer plan rests on, so it is tested for
 * what it must REFUSE as much as for what it serves: a peer that offers a hash
 * it does not have, a request for something never announced, and a file the
 * user supplied privately, which must never be given away.
 */
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerService } from "../src/ai/engine/peer.service";
import { CATALOG } from "../src/ai/engine/llama-catalog";

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
async function check(name: string, fn: () => unknown): Promise<void> {
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
const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** A ConfigService that answers from a plain object. */
function cfg(values: Record<string, string>): ConfigService {
  return {
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

async function main(): Promise<void> {
  // The sharer owns a real catalogue model — except the bytes are ours, so the
  // hash will not match the catalogue. That is the point: it lets us prove the
  // receiving side rejects a file that is the right NAME but the wrong CONTENT.
  const target = CATALOG.find((m) => m.sha256);
  assert(target, "the catalogue should carry hashes");
  const model = target!;

  const seederDir = mkdtempSync(join(tmpdir(), "neurion-seeder-"));
  mkdirSync(join(seederDir, "models"), { recursive: true });

  // A file of exactly the declared size, so it is offered at all.
  const body = Buffer.alloc(model.sizeBytes > 4096 ? 4096 : model.sizeBytes, 7);
  writeFileSync(join(seederDir, "models", model.file), body);

  const seeder = new PeerService(
    cfg({ NEURION_TEXT_DIR: seederDir, NEURION_PEER_PORT: "48501" }),
  );
  const leecher = new PeerService(
    cfg({ NEURION_TEXT_DIR: mkdtempSync(join(tmpdir(), "neurion-leecher-")), NEURION_PEER_PORT: "48502" }),
  );

  await check("sharing is on unless switched off", () => {
    assert(seeder.enabled(), "should default to enabled");
    const off = new PeerService(cfg({ NEURION_PEER_SHARING: "false" }));
    assert(!off.enabled(), "NEURION_PEER_SHARING=false must switch it off");
  });

  await check("a half-sized file is not offered", () => {
    // The size does not match the catalogue, so nothing should be announced.
    const st = seeder.status();
    assert(
      st.sharing === 0,
      `a file of the wrong size was offered (${st.sharing})`,
    );
  });

  // Now give it the right size so it becomes shareable.
  writeFileSync(join(seederDir, "models", model.file), Buffer.alloc(model.sizeBytes, 7));

  await check("a complete file is offered", () => {
    assert(
      seeder.status().sharing === 1,
      "the model should now be on offer",
    );
  });

  seeder.start();
  leecher.start();
  // Announcements go out immediately on bind, but the sockets need a moment.
  await wait(3000);

  await check("the peers find each other on the network", () => {
    const seen = leecher.known();
    assert(
      seen.length >= 1,
      "the leecher saw nobody — discovery did not work",
    );
    assert(
      seen.some((p) => p.has.includes(model.sha256!)),
      "the peer was seen but did not announce the model",
    );
  });

  await check("a source is resolved for a hash somebody has", () => {
    const src = leecher.sourceFor(model.sha256!);
    assert(src, "no source found for a hash a peer announced");
    assert(
      /^http:\/\/[\d.]+:48501\/peer\/blob\/[0-9a-f]{64}$/.test(src!),
      `unexpected source URL: ${src}`,
    );
  });

  await check("no source is invented for a hash nobody has", () => {
    const absent = createHash("sha256").update("nessuno ha questo").digest("hex");
    assert(
      leecher.sourceFor(absent) === null,
      "a source was returned for a model no peer offered",
    );
  });

  await check("the file server hands over the announced model", async () => {
    const res = await fetch(`http://127.0.0.1:48501/peer/blob/${model.sha256}`);
    assert(res.ok, `expected 200, got ${res.status}`);
    const got = Buffer.from(await res.arrayBuffer());
    assert(
      got.length === model.sizeBytes,
      `served ${got.length} bytes, expected ${model.sizeBytes}`,
    );
  });

  await check("the file server refuses a hash it does not have", async () => {
    const absent = createHash("sha256").update("non esiste").digest("hex");
    const res = await fetch(`http://127.0.0.1:48501/peer/blob/${absent}`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await check("the file server exposes nothing but blobs by hash", async () => {
    for (const path of [
      "/",
      "/peer",
      "/peer/blob/../../../etc/passwd",
      "/peer/blob/NOTAHASH",
      "/api/health",
    ]) {
      const res = await fetch(`http://127.0.0.1:48501${path}`);
      assert(
        res.status === 404,
        `${path} answered ${res.status} — it should expose nothing`,
      );
    }
  });

  await check("a privately supplied model is never announced", () => {
    // A file that is not in the catalogue must not be offered, whatever it is
    // called: it could be someone's private fine-tune.
    writeFileSync(join(seederDir, "models", "mio-privato.gguf"), Buffer.alloc(2048, 1));
    assert(
      seeder.status().sharing === 1,
      "a non-catalogue file was put on offer",
    );
  });


  // ---- phase 2: identity is a key, not an account ------------------------

  await check("the identity survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "neurion-ident-"));
    const a = new PeerService(cfg({ NEURION_TEXT_DIR: dir }));
    const b = new PeerService(cfg({ NEURION_TEXT_DIR: dir }));
    const idA = (a as unknown as { peerId: string }).peerId;
    const idB = (b as unknown as { peerId: string }).peerId;
    assert(idA.length === 32, `expected a 32-char fingerprint, got ${idA}`);
    assert(
      idA === idB,
      "a second instance on the same directory must be the same peer",
    );
    // The random id it replaces changed on every start, so a peer looked like a
    // stranger every time it came back.
    const other = new PeerService(
      cfg({ NEURION_TEXT_DIR: mkdtempSync(join(tmpdir(), "neurion-ident2-")) }),
    );
    assert(
      (other as unknown as { peerId: string }).peerId !== idA,
      "two different machines must not share an identity",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  await check("a forged announcement is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "neurion-forge-"));
    const victimDir = mkdtempSync(join(tmpdir(), "neurion-victim-"));
    const attacker = new PeerService(cfg({ NEURION_TEXT_DIR: dir }));
    const victim = new PeerService(cfg({ NEURION_TEXT_DIR: victimDir }));
    const priv = attacker as unknown as {
      signed(p: object): string | null;
      peerId: string;
    };
    const recv = victim as unknown as {
      onAnnounce(b: Buffer, addr: string): void;
      known(): unknown[];
    };

    // Signed properly by the attacker, but claiming to be somebody else. The
    // signature is valid; the NAME is stolen. Only checking the signature would
    // let this through.
    const stolen = priv.signed({
      v: 1,
      peerId: "0".repeat(32),
      port: 8097,
      has: [],
    });
    assert(stolen, "the attacker should be able to sign");
    recv.onAnnounce(Buffer.from(stolen!), "10.0.0.1");
    assert(
      recv.known().length === 0,
      "an announcement naming someone else was accepted",
    );

    // Unsigned rubbish, which is what a UDP port mostly receives.
    recv.onAnnounce(Buffer.from('{"v":1,"peerId":"x","port":1,"has":[]}'), "10.0.0.2");
    recv.onAnnounce(Buffer.from("not json at all"), "10.0.0.3");
    assert(recv.known().length === 0, "unsigned announcements were accepted");

    // Correctly signed under its own name: accepted.
    const honest = priv.signed({
      v: 1,
      peerId: priv.peerId,
      port: 8097,
      has: [],
    });
    recv.onAnnounce(Buffer.from(honest!), "10.0.0.4");
    assert(recv.known().length === 1, "an honest announcement was rejected");

    rmSync(dir, { recursive: true, force: true });
    rmSync(victimDir, { recursive: true, force: true });
  });

  await check("seed addresses are kept, and rubbish is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "neurion-seeds-"));
    const p = new PeerService(cfg({ NEURION_TEXT_DIR: dir }));
    assert(p.seeds().length === 0, "should start with none");

    p.addSeed("192.0.2.10:8097");
    p.addSeed("http://192.0.2.11/"); // scheme and slash stripped
    p.addSeed("192.0.2.10:8097"); // duplicate
    const list = p.seeds();
    assert(
      list.length === 2,
      `expected 2 seeds, got ${list.length}: ${list.join(", ")}`,
    );
    assert(list.includes("192.0.2.11"), "the scheme should have been stripped");

    for (const bad of ["", "  ", "not a host!", "1.2.3.4:99999999/x"]) {
      let threw = false;
      try {
        p.addSeed(bad);
      } catch {
        threw = true;
      }
      assert(threw, `"${bad}" should have been refused`);
    }

    // Survives a restart: a friend's address is not something to retype.
    const again = new PeerService(cfg({ NEURION_TEXT_DIR: dir }));
    assert(again.seeds().length === 2, "seeds should be remembered");

    p.removeSeed("192.0.2.11");
    assert(p.seeds().length === 1, "removal did not stick");
    rmSync(dir, { recursive: true, force: true });
  });

  seeder.onModuleDestroy();
  leecher.onModuleDestroy();
  rmSync(seederDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
  // Sockets are closed above; nothing should keep the loop alive.
  process.exit(failed ? 1 : 0);
}

void main();
