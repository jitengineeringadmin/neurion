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
    cfg({
      NEURION_TEXT_DIR: seederDir,
      NEURION_PEER_PORT: "48501",
      // Isolated from whatever is really running on this machine: without
      // this the test discovers the live app and asserts against it.
      NEURION_PEER_SWEEP: "false",
    }),
  );
  const leecher = new PeerService(
    cfg({
      NEURION_TEXT_DIR: mkdtempSync(join(tmpdir(), "neurion-leecher-")),
      NEURION_PEER_PORT: "48502",
      NEURION_PEER_SWEEP: "false",
    }),
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
    // Any peer offering it is a correct answer, and on a live network there may
    // genuinely be more than one — a real Neurion on this machine announces too.
    // What must hold is the shape, and that the seeder is one of the sources.
    assert(
      src!.startsWith("http://") &&
        src!.endsWith(`/peer/blob/${model.sha256}`),
      `unexpected source URL: ${src}`,
    );
    assert(
      leecher
        .known()
        .some((p) => p.port === 48501 && p.has.includes(model.sha256!)),
      "the test seeder was not among the peers offering the model",
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


  // ---- phase 3: lending the machine, not just the file -------------------

  await check("compute is off unless somebody switched it on", () => {
    // Serving a file is a disk read. Running a prompt takes the owner's
    // processor and slows their own machine down, so it cannot be a default
    // they discover afterwards.
    const off = new PeerService(cfg({ NEURION_TEXT_DIR: seederDir }));
    assert(!off.computeEnabled(), "compute sharing must default to off");
    const on = new PeerService(
      cfg({ NEURION_TEXT_DIR: seederDir, NEURION_PEER_COMPUTE: "true" }),
    );
    assert(on.computeEnabled(), "NEURION_PEER_COMPUTE=true must switch it on");
  });

  await check("a machine with compute off refuses to run anything", async () => {
    const res = await fetch("http://127.0.0.1:48501/peer/infer", {
      method: "POST",
      body: JSON.stringify({ sha256: model.sha256, prompt: "ciao" }),
    });
    assert(res.status === 403, `expected 403, got ${res.status}`);
  });

  // A machine that does lend, but has nothing loaded.
  const lenderDir = mkdtempSync(join(tmpdir(), "neurion-lender-"));
  mkdirSync(join(lenderDir, "models"), { recursive: true });
  const lender = new PeerService(
    cfg({
      NEURION_TEXT_DIR: lenderDir,
      NEURION_PEER_PORT: "48503",
      NEURION_PEER_COMPUTE: "true",
      NEURION_PEER_SWEEP: "false",
    }),
  );
  lender.start();
  await wait(1200);

  await check("a request for a model that is not loaded is turned away", async () => {
    const res = await fetch("http://127.0.0.1:48503/peer/infer", {
      method: "POST",
      body: JSON.stringify({ sha256: model.sha256, prompt: "ciao" }),
    });
    // 409 rather than a generic error, so the asker can decide to fetch the
    // weights instead of guessing why they were refused.
    assert(res.status === 409, `expected 409, got ${res.status}`);
    const why = await res.text();
    assert(/not the one loaded/.test(why), `unhelpful reason: ${why}`);
  });

  await check("malformed requests are refused", async () => {
    const cases: Array<[string, unknown]> = [
      ["no sha", { prompt: "ciao" }],
      ["not a hash", { sha256: "nope", prompt: "ciao" }],
      ["no prompt", { sha256: model.sha256 }],
      ["empty prompt", { sha256: model.sha256, prompt: "   " }],
    ];
    for (const [name, payload] of cases) {
      const res = await fetch("http://127.0.0.1:48503/peer/infer", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      assert(res.status === 400, `${name}: expected 400, got ${res.status}`);
    }
    const bad = await fetch("http://127.0.0.1:48503/peer/infer", {
      method: "POST",
      body: "{not json",
    });
    assert(bad.status === 400, `bad json: expected 400, got ${bad.status}`);
  });

  await check("an oversized prompt is refused rather than swallowed", async () => {
    const res = await fetch("http://127.0.0.1:48503/peer/infer", {
      method: "POST",
      body: JSON.stringify({
        sha256: model.sha256,
        prompt: "x".repeat(300_000),
      }),
    });
    assert(res.status === 413, `expected 413, got ${res.status}`);
  });

  await check("a peer that does not lend is never chosen to compute", () => {
    // seeder has compute off; nobody should be picked for it.
    assert(
      leecher.computeSourceFor(model.sha256!) === null,
      "a peer with compute off was offered as a source",
    );
  });

  lender.onModuleDestroy();
  rmSync(lenderDir, { recursive: true, force: true });


  // ---- the network is remembered, the way eMule remembered its servers ----

  await check("a peer that answered is written down for next time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "neurion-nodes-"));
    const client = new PeerService(
      cfg({
        NEURION_TEXT_DIR: dir,
        NEURION_PEER_PORT: "48504",
        NEURION_PEER_SWEEP: "false",
      }),
    );
    assert(client.savedNodes().length === 0, "should start knowing nobody");

    // The in-test seeder is a real peer on 48501; asking it should be enough to
    // be remembered.
    await (client as unknown as {
      ask(a: string, p: number): Promise<void>;
    }).ask("127.0.0.1", 48501);

    const saved = client.savedNodes();
    // More than one, because asking that peer also produced the peers IT knew
    // and we verified those ourselves — which is gossip doing its job. One
    // introduction is enough to learn the neighbourhood.
    assert(saved.length >= 1, `nothing was remembered`);
    assert(
      saved.some((n) => n.port === 48501),
      `the peer we actually asked is missing: ${saved.map((n) => n.port).join(", ")}`,
    );

    // A brand-new instance on the same directory knows where to knock — this is
    // the whole point: a machine switched off for a week still finds its way in.
    const afterRestart = new PeerService(cfg({ NEURION_TEXT_DIR: dir }));
    assert(
      afterRestart.savedNodes().length === saved.length,
      "the list did not survive a restart",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  await check("a machine that answers nothing is not remembered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "neurion-nonodes-"));
    const client = new PeerService(
      cfg({ NEURION_TEXT_DIR: dir, NEURION_PEER_SWEEP: "false" }),
    );
    // Port 9 is discard; nothing there speaks our protocol.
    await (client as unknown as {
      ask(a: string, p: number): Promise<void>;
    }).ask("127.0.0.1", 9);
    assert(
      client.savedNodes().length === 0,
      "an address that never answered was written down",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  await check("the remembered list does not grow without limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "neurion-cap-"));
    const client = new PeerService(cfg({ NEURION_TEXT_DIR: dir }));
    const remember = (client as unknown as {
      rememberNode(a: string, p: number): void;
    }).rememberNode.bind(client);
    for (let i = 0; i < 260; i++) remember(`10.1.${Math.floor(i / 254)}.${i % 254}`, 8097);
    const saved = client.savedNodes();
    assert(saved.length === 200, `expected a cap of 200, got ${saved.length}`);
    // Newest first, so the most recently seen survive a trim.
    assert(
      saved[0]!.address.startsWith("10.1."),
      "the most recent entry should be at the front",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- what two answers are worth, and saying so honestly ---------------
  //
  // Measured on two real machines: asked to run reproducibly, different
  // processors returned identical text. So "identical" and "similar" are not
  // the same claim and must not carry the same label.

  await check("two answers are labelled by how much they really agree", async () => {
    const { createServer } = await import("node:http");
    const fake = (port: number, id: string, text: string) => {
      const srv = createServer((req, res) => {
        if (req.url === "/peer/have") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              v: 1,
              peerId: id,
              has: [model.sha256],
              compute: true,
              running: model.sha256,
              peers: [],
            }),
          );
          return;
        }
        if (req.url === "/peer/infer") {
          req.on("data", () => {});
          req.on("end", () => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ v: 1, text }));
          });
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      return new Promise<import("node:http").Server>((r) =>
        srv.listen(port, "127.0.0.1", () => r(srv)),
      );
    };

    const cases: Array<[string, string, string]> = [
      // Same text: the strongest thing two peers can say.
      ["identical", "il gatto dorme sul tetto caldo", "il gatto dorme sul tetto caldo"],
      // Same words, different order and one changed: close, not the same.
      ["agreed", "il gatto dorme sul tetto caldo", "sul tetto caldo il gatto dorme adesso"],
      // Nothing in common: one of them is wrong and we cannot say which.
      ["disagreed", "il gatto dorme sul tetto caldo", "domani piove a Milano forse"],
    ];

    for (const [i, [expected, one, two]] of cases.entries()) {
      // Fresh ports each round: a socket just closed is not instantly free to
      // bind again, and a peer that was not listening yet reads as one peer,
      // which would quietly turn this into a different test.
      const portA = 48560 + i * 2;
      const portB = 48561 + i * 2;
      const dirX = mkdtempSync(join(tmpdir(), "neurion-conf-"));
      const asker = new PeerService(
        cfg({
          NEURION_TEXT_DIR: dirX,
          NEURION_PEER_PORT: "48551",
          NEURION_PEER_SWEEP: "false",
        }),
      );
      const a = await fake(portA, "a".repeat(32), one);
      const b = await fake(portB, "b".repeat(32), two);
      await (asker as unknown as { ask(h: string, p: number): Promise<void> }).ask("127.0.0.1", portA);
      await (asker as unknown as { ask(h: string, p: number): Promise<void> }).ask("127.0.0.1", portB);
      assert(
        asker.computeCandidates(model.sha256!).length === 2,
        `only ${asker.computeCandidates(model.sha256!).length} peer(s) answered; this case needs two`,
      );
      const out = await asker.borrow(model.sha256!, "una domanda", 50);
      assert(out, `no answer for the ${expected} case`);
      assert(
        out!.confidence === expected,
        `expected ${expected}, got ${out!.confidence} (overlap ${out!.similarity})`,
      );
      asker.onModuleDestroy();
      a.closeAllConnections?.();
      b.closeAllConnections?.();
      await new Promise<void>((r) => a.close(() => r()));
      await new Promise<void>((r) => b.close(() => r()));
      rmSync(dirX, { recursive: true, force: true });
    }
  });

  await check("one peer is never called verified", async () => {
    const { createServer } = await import("node:http");
    const dirY = mkdtempSync(join(tmpdir(), "neurion-single-"));
    const asker = new PeerService(
      cfg({
        NEURION_TEXT_DIR: dirY,
        NEURION_PEER_PORT: "48554",
        NEURION_PEER_SWEEP: "false",
      }),
    );
    const srv = createServer((req, res) => {
      if (req.url === "/peer/have") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            v: 1,
            peerId: "c".repeat(32),
            has: [model.sha256],
            compute: true,
            running: model.sha256,
            peers: [],
          }),
        );
        return;
      }
      if (req.url === "/peer/infer") {
        req.on("data", () => {});
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ v: 1, text: "una risposta sola" }));
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => srv.listen(48555, "127.0.0.1", () => r()));
    await (asker as unknown as { ask(h: string, p: number): Promise<void> }).ask("127.0.0.1", 48555);
    const out = await asker.borrow(model.sha256!, "una domanda", 50);
    assert(out?.confidence === "single", `a lone peer was labelled ${out?.confidence}`);
    asker.onModuleDestroy();
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
    rmSync(dirY, { recursive: true, force: true });
  });

  // ---- the switch that has to exist now that the index is global --------

  await check("sharing can be switched off, and it stops at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "neurion-switch-"));
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(
      join(dir, "models", model.file),
      Buffer.alloc(model.sizeBytes, 7),
    );
    const node = new PeerService(
      cfg({
        NEURION_TEXT_DIR: dir,
        NEURION_PEER_PORT: "48521",
        NEURION_PEER_SWEEP: "false",
      }),
    );
    const url = `http://127.0.0.1:48521/peer/blob/${model.sha256}`;
    node.start();
    await wait(500);
    assert(
      (await fetch(url, { method: "HEAD" })).ok,
      "not serving while sharing is on",
    );

    node.setSharingEnabled(false);
    await wait(300);
    let stopped = false;
    try {
      const res = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(1500),
      });
      stopped = !res.ok;
    } catch {
      stopped = true; // refused or dropped, both mean off
    }
    assert(stopped, "still serving after sharing was switched off");
    assert(!node.enabled(), "the switch says on while nothing is served");

    // The choice belongs to the person, so it outlives the process.
    const restarted = new PeerService(cfg({ NEURION_TEXT_DIR: dir }));
    assert(!restarted.enabled(), "the decision was forgotten on restart");

    node.setSharingEnabled(true);
    await wait(600);
    assert(
      (await fetch(url, { method: "HEAD" })).ok,
      "sharing did not come back when switched on again",
    );
    node.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- a model too big for one file, and too big for one person ----------
  //
  // Past a certain size a model arrives as a numbered set of files. Each part
  // carries its own hash, which turns out to matter more than it sounds:
  // somebody holding two parts of three is already useful to somebody holding
  // none, and a transfer that dies halfway costs one part instead of eighty
  // gigabytes.

  await check("each part of a split model is offered on its own", () => {
    const split = CATALOG.find((m) => m.parts?.length);
    assert(split, "the catalogue should have at least one split model");
    const first = split!.parts![0]!;
    // Only part one is small enough to actually create — which is the point of
    // the test: having ONE part must already put something on offer.
    assert(
      first.sizeBytes < 20_000_000,
      `part one is ${first.sizeBytes} bytes; this test assumes it is small`,
    );
    const dir = mkdtempSync(join(tmpdir(), "neurion-parts-"));
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(join(dir, "models", first.file), Buffer.alloc(first.sizeBytes, 3));
    const node = new PeerService(
      cfg({ NEURION_TEXT_DIR: dir, NEURION_PEER_SWEEP: "false" }),
    );
    const offered = node.status().sharing;
    assert(
      offered === 1,
      `holding one part of ${split!.parts!.length} should offer exactly one thing, got ${offered}`,
    );
    // And it is findable by that part's own hash, not the model's.
    assert(
      node.sourceFor(first.sha256) === null,
      "no peer has it, so no source should be invented",
    );
    const inner = node as unknown as {
      localHashes(): Map<string, unknown>;
    };
    assert(
      inner.localHashes().has(first.sha256),
      "the part is on disk but not offered under its own hash",
    );
    assert(
      !inner.localHashes().has(split!.parts![1]!.sha256),
      "a part that is NOT on disk was offered anyway",
    );
    node.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  });

  await check("a part of the wrong size is not offered", () => {
    const split = CATALOG.find((m) => m.parts?.length)!;
    const first = split.parts![0]!;
    const dir = mkdtempSync(join(tmpdir(), "neurion-partial-"));
    mkdirSync(join(dir, "models"), { recursive: true });
    // A download that stopped halfway. The hash would catch it later; refusing
    // to announce it saves somebody the wasted transfer.
    writeFileSync(
      join(dir, "models", first.file),
      Buffer.alloc(Math.floor(first.sizeBytes / 2), 3),
    );
    const node = new PeerService(
      cfg({ NEURION_TEXT_DIR: dir, NEURION_PEER_SWEEP: "false" }),
    );
    assert(
      node.status().sharing === 0,
      "a half-written part was put on offer",
    );
    node.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- being a good guest on somebody else's machine ---------------------
  //
  // None of this is about security. It is about whether the person who
  // installed this keeps it installed: a sharing client with no upload ceiling
  // takes the household's connection and gets uninstalled, correctly.

  const hostDir = mkdtempSync(join(tmpdir(), "neurion-host-"));
  mkdirSync(join(hostDir, "models"), { recursive: true });
  writeFileSync(
    join(hostDir, "models", model.file),
    Buffer.alloc(model.sizeBytes, 7),
  );
  const host = new PeerService(
    cfg({
      NEURION_TEXT_DIR: hostDir,
      NEURION_PEER_PORT: "48571",
      NEURION_PEER_SWEEP: "false",
      // Everything in a test is loopback, which is exempt from the ceiling by
      // design. Metering is forced on so the ceiling can be tested at all —
      // the same setting somebody on a phone hotspot would use for real.
      NEURION_PEER_METER_LOCAL: "true",
    }),
  );
  (host as unknown as { serve(): void }).serve();
  await wait(400);
  const blobUrl = `http://127.0.0.1:48571/peer/blob/${model.sha256}`;

  await check("the defaults protect the connection rather than the network", () => {
    const l = host.limits();
    assert(l.slots > 0 && l.slots <= 10, `odd slot default: ${l.slots}`);
    assert(
      l.kbPerSecond > 0,
      "the rate ceiling is off by default; a stranger's install would have no protection",
    );
  });

  await check("one machine cannot hold every slot", async () => {
    host.setLimits({ slots: 2, kbPerSecond: 0 });
    // Two at once from the SAME address: the second must be refused, or one
    // peer alone could occupy the whole upload capacity.
    const first = fetch(blobUrl);
    await wait(120);
    const second = await fetch(blobUrl);
    assert(
      second.status === 503,
      `a second transfer to the same machine got ${second.status}`,
    );
    assert(
      second.headers.get("retry-after") !== null,
      "a refusal should say when to come back",
    );
    const done = await first;
    await done.arrayBuffer();
  });

  await check("a refused transfer does not count as one served", async () => {
    const before = host.status().served;
    host.setLimits({ slots: 1, kbPerSecond: 0 });
    const first = fetch(blobUrl);
    await wait(120);
    const refused = await fetch(blobUrl);
    assert(refused.status === 503, `expected 503, got ${refused.status}`);
    await (await first).arrayBuffer();
    assert(
      host.status().served === before + 1,
      "a refusal was counted as a model handed over",
    );
  });

  await check("the rate ceiling actually holds the transfer back", async () => {
    // The file is model.sizeBytes; at this ceiling it cannot possibly arrive
    // in under a second, and without the throttle it arrives instantly.
    const perSecond = Math.max(1, Math.floor(model.sizeBytes / 1024 / 2));
    host.setLimits({ slots: 3, kbPerSecond: perSecond });
    const t0 = Date.now();
    const res = await fetch(blobUrl);
    await res.arrayBuffer();
    const took = Date.now() - t0;
    assert(res.ok, `the transfer failed: ${res.status}`);
    assert(
      took >= 900,
      `${model.sizeBytes} bytes at ${perSecond} KB/s took ${took}ms — the ceiling is not being applied`,
    );
    host.setLimits({ slots: 3, kbPerSecond: 0 });
  });

  await check("a blocked machine is told nothing at all", async () => {
    host.block("127.0.0.1");
    for (const path of ["/peer/have", `/peer/blob/${model.sha256}`]) {
      const res = await fetch(`http://127.0.0.1:48571${path}`);
      assert(
        res.status === 403,
        `${path} answered ${res.status} to a blocked machine`,
      );
    }
    // And it is gone from the live picture, not merely refused next time.
    assert(
      !host.known().some((p) => p.address === "127.0.0.1"),
      "a blocked machine was still listed as a peer",
    );
    host.unblock("127.0.0.1");
    const back = await fetch("http://127.0.0.1:48571/peer/have");
    assert(back.ok, "unblocking did not restore the machine");
  });

  await check("a machine on your own network is not slowed down", async () => {
    // The ceiling protects the line out of the house. A copy that never leaves
    // the switch costs nothing, and throttling it would turn a one minute
    // transfer into a quarter of an hour for no reason at all.
    const homeDir = mkdtempSync(join(tmpdir(), "neurion-home-"));
    mkdirSync(join(homeDir, "models"), { recursive: true });
    writeFileSync(
      join(homeDir, "models", model.file),
      Buffer.alloc(model.sizeBytes, 7),
    );
    const home = new PeerService(
      cfg({
        NEURION_TEXT_DIR: homeDir,
        NEURION_PEER_PORT: "48572",
        NEURION_PEER_SWEEP: "false",
      }),
    );
    (home as unknown as { serve(): void }).serve();
    await wait(400);
    // A ceiling so low that any throttling at all would be obvious.
    home.setLimits({ slots: 3, kbPerSecond: 1 });
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:48572/peer/blob/${model.sha256}`);
    await res.arrayBuffer();
    const took = Date.now() - t0;
    assert(res.ok, `the transfer failed: ${res.status}`);
    assert(
      took < 2000,
      `a copy on the same machine took ${took}ms at a 1 KB/s ceiling — the ceiling is being applied where nothing is being spent`,
    );
    home.onModuleDestroy();
    rmSync(homeDir, { recursive: true, force: true });
  });

  await check("a nonsense address cannot be blocked", () => {
    let refused = false;
    try {
      host.block("../../etc/passwd");
    } catch {
      refused = true;
    }
    assert(refused, "a path was accepted as an address to block");
  });

  await check("the router is not touched until somebody says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "neurion-reach-"));
    const fresh = new PeerService(
      cfg({ NEURION_TEXT_DIR: dir, NEURION_PEER_SWEEP: "false" }),
    );
    assert(
      fresh.reachability() === "unset",
      "a fresh install already has an answer nobody gave",
    );
    assert(fresh.setReachable(false) === "off", "saying no did not take");
    assert(
      fresh.reachability() === "off",
      "the answer was not remembered",
    );
    const restarted = new PeerService(cfg({ NEURION_TEXT_DIR: dir }));
    assert(
      restarted.reachability() === "off",
      "the answer did not survive a restart",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  host.onModuleDestroy();
  rmSync(hostDir, { recursive: true, force: true });

  // ---- reaching somebody who cannot be reached ---------------------------
  //
  // Plenty of connections cannot be opened from the inside — mobile networks
  // above all — and on those a peer could take and never give. eMule answered
  // this in 2002 with the LowID: keep a connection open TOWARDS somebody who
  // can be reached, and be reached back through it.
  //
  // The test is the whole claim: a machine that never accepts an incoming
  // connection still hands a model to a stranger.

  const relayDirs: string[] = [];
  const mkRelayNode = (port: string, withModel: boolean): PeerService => {
    const dir = mkdtempSync(join(tmpdir(), "neurion-relay-"));
    relayDirs.push(dir);
    if (withModel) {
      mkdirSync(join(dir, "models"), { recursive: true });
      writeFileSync(
        join(dir, "models", model.file),
        Buffer.alloc(model.sizeBytes, 7),
      );
    }
    return new PeerService(
      cfg({
        NEURION_TEXT_DIR: dir,
        NEURION_PEER_PORT: port,
        NEURION_PEER_SWEEP: "false",
        // Loopback would otherwise be exempt from the ceiling, and the relay
        // path has to obey the same limits as a direct transfer.
        NEURION_PEER_METER_LOCAL: "false",
      }),
    );
  };

  type RelayInnards = {
    serve(): void;
    ensureRelayed(): Promise<void>;
    signed(payload: object): string | null;
    myRelay: { address: string; port: number } | null;
    ask(a: string, p: number): Promise<void>;
  };

  // The carrier has an open door. The hidden one has the model but never
  // accepts a connection — its server is simply never started.
  const carrier = mkRelayNode("48581", false);
  const hidden = mkRelayNode("48582", true);
  (carrier as unknown as RelayInnards).serve();
  await wait(400);

  await check("a machine with no open door still finds a carrier", async () => {
    // It knows the carrier the ordinary way, by asking it.
    await (hidden as unknown as RelayInnards).ask("127.0.0.1", 48581);
    await (hidden as unknown as RelayInnards).ensureRelayed();
    const r = (hidden as unknown as RelayInnards).myRelay;
    assert(r, "no peer agreed to answer on its behalf");
    assert(r!.port === 48581, `attached to the wrong peer: ${r!.port}`);
  });

  await check("a stranger gets the model THROUGH the carrier", async () => {
    // Proof the hidden machine really is unreachable: nothing is listening.
    let direct = "reachable";
    try {
      await fetch(`http://127.0.0.1:48582/peer/have`, {
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      direct = "refused";
    }
    assert(direct === "refused", "the hidden peer is answering directly; nothing is being proven");

    // Give the poll a moment to be parked on the carrier.
    await wait(1200);
    const url =
      `http://127.0.0.1:48581/peer/blob/${model.sha256}?via=${hidden.myPeerId()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    assert(res.ok, `the relayed fetch answered ${res.status}`);
    const got = Buffer.from(await res.arrayBuffer());
    assert(
      got.length === model.sizeBytes,
      `got ${got.length} bytes, expected ${model.sizeBytes}`,
    );
    assert(got[0] === 7 && got[got.length - 1] === 7, "the bytes are not the model");
  });

  await check("a carrier refuses a name it never agreed to answer for", async () => {
    // Anyone can write "reach me through R" in the index. R must not play along.
    const invented = "f".repeat(32);
    const res = await fetch(
      `http://127.0.0.1:48581/peer/blob/${model.sha256}?via=${invented}`,
      { signal: AbortSignal.timeout(5000) },
    );
    assert(
      res.status === 404,
      `a stranger's claim to be relayed was honoured with ${res.status}`,
    );
  });

  await check("an unsigned request cannot take a relay seat", async () => {
    for (const path of ["/peer/relay/register", "/peer/relay/poll"]) {
      const res = await fetch(`http://127.0.0.1:48581${path}`, {
        method: "POST",
        body: JSON.stringify({ peerId: "a".repeat(32) }),
        signal: AbortSignal.timeout(5000),
      });
      assert(res.status === 403, `${path} answered ${res.status} to an unsigned request`);
    }
  });

  await check("a relayed transfer costs the carrier a normal upload slot", () => {
    // The point of the design: agreeing to carry somebody never gives away
    // more than was already agreed to give.
    const before = carrier.status().served;
    assert(before >= 1, "the carrier did not count the relayed transfer as served");
    assert(
      carrier.limits().slots > 0,
      "the carrier has no slot limit, so relaying would be unbounded",
    );
  });

  hidden.onModuleDestroy();
  carrier.onModuleDestroy();
  for (const d of relayDirs) rmSync(d, { recursive: true, force: true });

  // ---- the distributed index, over a real wire ---------------------------
  //
  // kad-test.ts proves the algorithm with sixty nodes and a fake transport.
  // This proves the parts that a fake transport cannot: the HTTP route, the
  // signatures in both directions, and the rule that an announcer's address is
  // the one we observed rather than the one it claimed.
  //
  // The shape is deliberately a chain. C is told about B and nothing else, and
  // never speaks to A until the index sends it there — which is exactly the
  // claim being tested: finding a model on a machine you have never met.

  const dhtDirs: string[] = [];
  const mkNode = (port: string, withModel: boolean): PeerService => {
    const dir = mkdtempSync(join(tmpdir(), "neurion-dht-"));
    dhtDirs.push(dir);
    if (withModel) {
      mkdirSync(join(dir, "models"), { recursive: true });
      writeFileSync(
        join(dir, "models", model.file),
        Buffer.alloc(model.sizeBytes, 7),
      );
    }
    return new PeerService(
      cfg({
        NEURION_TEXT_DIR: dir,
        NEURION_PEER_PORT: port,
        NEURION_PEER_SWEEP: "false",
      }),
    );
  };

  type Innards = {
    serve(): void;
    kad(): { seen(c: { id: string; address: string; port: number }): void; size(): number };
    joinNetwork(): Promise<void>;
    signed(payload: object): string | null;
  };

  const holder = mkNode("48511", true);
  const middle = mkNode("48512", false);
  const newcomer = mkNode("48513", false);
  // Only the file server, never discovery: multicast on this machine would
  // introduce all three to each other and there would be nothing left to prove.
  for (const n of [holder, middle, newcomer]) (n as unknown as Innards).serve();
  await wait(400);

  // The chain: the middle knows the holder, the newcomer knows the middle.
  (middle as unknown as Innards)
    .kad()
    .seen({ id: holder.myPeerId(), address: "127.0.0.1", port: 48511 });
  (newcomer as unknown as Innards)
    .kad()
    .seen({ id: middle.myPeerId(), address: "127.0.0.1", port: 48512 });

  await check("a machine finds a model through a stranger it was routed to", async () => {
    assert(
      newcomer.known().length === 0,
      "the newcomer already knows a peer, so this would prove nothing",
    );
    assert(
      newcomer.sourceFor(model.sha256!) === null,
      "the neighbour path already answers; the index is not being tested",
    );
    const url = await newcomer.locate(model.sha256!);
    assert(url, "the index did not find the model");
    assert(
      url!.includes(":48511/"),
      `routed to the wrong machine: ${url}`,
    );
    // And having been there, it is now a peer like any other.
    assert(
      newcomer.known().some((p) => p.peerId === holder.myPeerId()),
      "the machine found through the index was not remembered afterwards",
    );
  });

  await check("announcing puts a record on somebody else's machine", async () => {
    assert(
      middle.indexStatus().records === 0,
      "the middle already held records before anyone announced",
    );
    await (holder as unknown as Innards).joinNetwork();
    assert(
      middle.indexStatus().records >= 1,
      "nobody kept a record of what the holder announced",
    );
  });

  await check("a stranger finds a machine willing to RUN a model", async () => {
    // Lending is a different offer from holding, filed under a different key.
    holder.setComputeEnabled(true);
    holder.setRunningModel(model.sha256!);
    await (holder as unknown as Innards).joinNetwork();

    const lenders = await (
      newcomer as unknown as {
        findLenders(sha: string, want: number): Promise<Array<{ peerId: string }>>;
      }
    ).findLenders(model.sha256!, 2);
    assert(lenders.length >= 1, "nobody was found willing to run it");
    assert(
      lenders.some((l) => l.peerId === holder.myPeerId()),
      "the wrong machine came back as a lender",
    );
  });

  await check("an offer that has stopped being true is not used", async () => {
    // The record stays in the index for half an hour, but the offer died the
    // moment another model was loaded. The index is a claim; the machine is
    // the authority, and it is asked.
    const other = createHash("sha256").update("un altro modello").digest("hex");
    holder.setRunningModel(other);
    const lenders = await (
      newcomer as unknown as {
        findLenders(sha: string, want: number): Promise<Array<{ peerId: string }>>;
      }
    ).findLenders(model.sha256!, 2);
    assert(
      lenders.length === 0,
      "a stale offer was believed without asking the machine itself",
    );

    // Same again for the switch rather than the model.
    holder.setRunningModel(model.sha256!);
    holder.setComputeEnabled(false);
    const none = await (
      newcomer as unknown as {
        findLenders(sha: string, want: number): Promise<Array<{ peerId: string }>>;
      }
    ).findLenders(model.sha256!, 2);
    assert(
      none.length === 0,
      "a machine that had switched lending off was still offered up",
    );
    holder.setComputeEnabled(true);
  });

  await check("an unsigned request to the index is refused", async () => {
    const res = await fetch("http://127.0.0.1:48512/peer/kad", {
      method: "POST",
      body: JSON.stringify({ req: { t: "ping" } }),
    });
    assert(res.status === 403, `an unsigned request got ${res.status}`);
  });

  await check("a signed request in somebody else's name is refused", async () => {
    // Correctly signed, and the signature is valid — but the name inside does
    // not belong to the key that signed it.
    const wire = (newcomer as unknown as Innards).signed({
      v: 1,
      peerId: holder.myPeerId(),
      port: 48513,
      req: { t: "ping" },
    });
    assert(wire, "could not build the test message");
    const res = await fetch("http://127.0.0.1:48512/peer/kad", {
      method: "POST",
      body: wire!,
    });
    assert(res.status === 403, `an impersonated request got ${res.status}`);
  });

  await check("a tampered request is refused", async () => {
    const wire = (newcomer as unknown as Innards).signed({
      v: 1,
      peerId: newcomer.myPeerId(),
      port: 48513,
      req: { t: "ping" },
    });
    const outer = JSON.parse(wire!) as { body: string };
    outer.body = outer.body.replace('"ping"', '"announce"');
    const res = await fetch("http://127.0.0.1:48512/peer/kad", {
      method: "POST",
      body: JSON.stringify(outer),
    });
    assert(res.status === 403, `a tampered request got ${res.status}`);
  });

  await check("a properly signed request is answered, and signed back", async () => {
    const wire = (newcomer as unknown as Innards).signed({
      v: 1,
      peerId: newcomer.myPeerId(),
      port: 48513,
      req: { t: "ping" },
    });
    const res = await fetch("http://127.0.0.1:48512/peer/kad", {
      method: "POST",
      body: wire!,
    });
    assert(res.status === 200, `a valid request got ${res.status}`);
    const outer = (await res.json()) as { body?: string; sig?: string; publicKey?: string };
    assert(outer.sig && outer.publicKey, "the answer came back unsigned");
    const inner = JSON.parse(outer.body!) as { peerId: string; res: { t: string } };
    assert(inner.peerId === middle.myPeerId(), "the answer was signed by the wrong machine");
    assert(inner.res.t === "pong", `unexpected answer: ${inner.res.t}`);
  });

  await check("an oversized ANSWER cannot fill this machine's memory", async () => {
    // The other direction, and the easier one to forget: we ask a peer, and the
    // peer answers with far more than any real reply could be. Reading it and
    // then measuring it would already have cost the memory.
    const { createServer } = await import("node:http");
    const flood = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Chunked, so there is no content-length to check: only counting stops it.
      for (let i = 0; i < 40; i++) res.write("x".repeat(50_000));
      res.end();
    });
    await new Promise<void>((r) => flood.listen(48531, "127.0.0.1", () => r()));
    const answer = await (
      newcomer as unknown as {
        kadSend(
          to: { id: string; address: string; port: number },
          req: { t: string },
        ): Promise<unknown>;
      }
    ).kadSend(
      { id: middle.myPeerId(), address: "127.0.0.1", port: 48531 },
      { t: "ping" },
    );
    assert(answer === null, "a two-megabyte answer was accepted as a reply");
    flood.closeAllConnections?.();
    await new Promise<void>((r) => flood.close(() => r()));
  });

  await check("an oversized request cannot fill this machine's memory", async () => {
    // Ten megabytes of nothing. The route must stop reading long before that.
    const huge = "x".repeat(10_000_000);
    let status = 0;
    try {
      const res = await fetch("http://127.0.0.1:48512/peer/kad", {
        method: "POST",
        body: JSON.stringify({ body: huge, sig: "x", publicKey: "x" }),
      });
      status = res.status;
    } catch {
      // The socket was torn down mid-upload, which is the intended outcome.
      status = 400;
    }
    assert(status === 400 || status === 403, `an oversized body got ${status}`);
  });

  for (const n of [holder, middle, newcomer]) n.onModuleDestroy();
  for (const d of dhtDirs) rmSync(d, { recursive: true, force: true });

  seeder.onModuleDestroy();
  leecher.onModuleDestroy();
  rmSync(seederDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
  // Sockets are closed above; nothing should keep the loop alive.
  process.exit(failed ? 1 : 0);
}

void main();
