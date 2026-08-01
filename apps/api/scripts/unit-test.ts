/**
 * Lightweight unit tests for the pure, security-critical logic (no DB / DI needed).
 * Run: pnpm --filter @neurion/api test:unit   (tsx scripts/unit-test.ts)
 */
import "reflect-metadata";
import assert from "node:assert";
import { PrivacyClassifierService } from "../src/ai/privacy/classifier.service";
import {
  maxPrivacy,
  allowedTrustLevels,
  CHAT_PRIVACY_FLOOR,
} from "../src/ai/privacy/privacy.util";
import { ThinkSplitter } from "../src/ai/providers/think-splitter";
import {
  cosine,
  embeddingMatches,
  ewma,
  consensus,
  protocolFee,
} from "../src/jobs/verification/helpers";

let passed = 0;
let failed = 0;
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

// ---- G2 privacy classifier (advisory, fail-safe-UP, can only raise the floor) ----
const clf = new PrivacyClassifierService();

test("plain text is not escalated", () => {
  const r = clf.classify("what is the capital of France?");
  assert.equal(r.category, "NONE");
  assert.equal(r.escalateTo, "PUBLIC");
  assert.equal(r.hardTrustedOnly, false);
});

test("email + phone flag PII and escalate to VERIFIED_ONLY", () => {
  const r = clf.classify(
    "contact me at mario.rossi@example.com or +39 333 1234567",
  );
  assert.ok(r.flags.includes("PII"));
  assert.equal(r.escalateTo, "VERIFIED_ONLY");
});

test("an API-key-like secret is SENSITIVE + hard trusted-only", () => {
  const r = clf.classify("here is my key sk-abcdefghijklmnopqrstuvwxyz0123");
  assert.ok(r.flags.includes("SECRET"));
  assert.equal(r.hardTrustedOnly, true);
  assert.equal(r.category, "SENSITIVE");
  assert.equal(r.escalateTo, "VERIFIED_ONLY");
});

test("a private key block is SENSITIVE", () => {
  const r = clf.classify("-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
  assert.ok(r.flags.includes("SECRET"));
  assert.equal(r.hardTrustedOnly, true);
});

test("Article 9 health/financial terms escalate + hard trusted-only", () => {
  const r = clf.classify("the patient was diagnosed with cancer last year");
  assert.ok(r.flags.includes("ART9"));
  assert.equal(r.hardTrustedOnly, true);
  assert.equal(r.escalateTo, "VERIFIED_ONLY");
});

test("classifier never throws — empty input is NONE", () => {
  const r = clf.classify("");
  assert.equal(r.category, "NONE");
  assert.equal(r.failedSafe, false);
});

// ---- privacy.util ordering + trust gating ----
test("maxPrivacy returns the stricter level", () => {
  assert.equal(maxPrivacy("PUBLIC", "VERIFIED_ONLY"), "VERIFIED_ONLY");
  assert.equal(maxPrivacy("VERIFIED_ONLY", "PUBLIC"), "VERIFIED_ONLY");
  assert.equal(maxPrivacy("PUBLIC", "PUBLIC"), "PUBLIC");
});

test("CHAT_PRIVACY_FLOOR is VERIFIED_ONLY (default chat floor)", () => {
  assert.equal(CHAT_PRIVACY_FLOOR, "VERIFIED_ONLY");
});

test("invariant: COMMUNITY allowed <=> effective is PUBLIC", () => {
  assert.ok(allowedTrustLevels("PUBLIC").has("COMMUNITY"));
  assert.ok(!allowedTrustLevels("VERIFIED_ONLY").has("COMMUNITY"));
  // VERIFIED_ONLY still permits VERIFIED+ nodes
  assert.ok(allowedTrustLevels("VERIFIED_ONLY").has("VERIFIED"));
  assert.ok(allowedTrustLevels("VERIFIED_ONLY").has("INTERNAL"));
});

// ---- G1 deep-verification math (compute verification / slashing) ----
test("cosine: identical=1, orthogonal=0, opposite=-1", () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-9);
});

test("embeddingMatches: exact reference passes", () => {
  const ref = [0.6, 0.8, 0.0];
  const m = embeddingMatches([0.6, 0.8, 0.0], ref);
  assert.equal(m.ok, true);
});

test("embeddingMatches: SCALED cheaper-model output is cosine-perfect but caught by norm-ratio (red-team)", () => {
  const ref = [0.6, 0.8]; // norm 1.0
  const scaled = ref.map((x) => x * 1.1); // same direction -> cosine 1, but norm 1.1x
  const m = embeddingMatches(scaled, ref);
  assert.ok(m.cos > 0.9999, "cosine is fooled");
  assert.equal(m.ok, false, "but norm-ratio rejects the scaled fake");
});

test("embeddingMatches: garbage (low cosine) fails", () => {
  const m = embeddingMatches([0.1, -0.9, 0.4], [0.6, 0.8, 0.0]);
  assert.equal(m.ok, false);
});

test("ewma: deep-PASS raises reputation, deep-FAIL lowers it", () => {
  assert.ok(ewma(0.5, 1) > 0.5);
  assert.ok(ewma(0.5, 0) < 0.5);
  assert.ok(Math.abs(ewma(0.5, 1) - 0.55) < 1e-9); // alpha 0.1
});

// ---- K-replica consensus ----
const ech = (id: string, v: string) => ({ nodeId: id, result: { echo: v } });
test("consensus: 3 identical echo -> all majority, no outliers", () => {
  const c = consensus("echo.v1", [ech("a", "x"), ech("b", "x"), ech("c", "x")]);
  assert.equal(c.agreed, true);
  assert.deepEqual(c.majority.sort(), ["a", "b", "c"]);
  assert.equal(c.outliers.length, 0);
});

test("consensus: 2 agree + 1 cheats -> majority 2, the cheat is the outlier", () => {
  const c = consensus("echo.v1", [
    ech("a", "x"),
    ech("b", "x"),
    ech("c", "WRONG"),
  ]);
  assert.equal(c.agreed, true);
  assert.deepEqual(c.majority.sort(), ["a", "b"]);
  assert.deepEqual(c.outliers, ["c"]);
});

test("consensus: all three differ -> no strict majority (escalate)", () => {
  const c = consensus("echo.v1", [ech("a", "1"), ech("b", "2"), ech("c", "3")]);
  assert.equal(c.agreed, false);
});

test("consensus: embedding clusters by cosine", () => {
  const a = { nodeId: "a", result: { vector: [0.6, 0.8] } };
  const b = { nodeId: "b", result: { vector: [0.6000001, 0.7999999] } }; // ~identical
  const c = { nodeId: "c", result: { vector: [-0.8, 0.6] } }; // orthogonal -> outlier
  const r = consensus("embedding.v1", [a, b, c]);
  assert.equal(r.agreed, true);
  assert.deepEqual(r.majority.sort(), ["a", "b"]);
  assert.deepEqual(r.outliers, ["c"]);
});

// ---- protocol take-rate ----
test("protocolFee: 10% of a reward, floored; 0 when off", () => {
  assert.equal(protocolFee(100, 1000), 10); // 10%
  assert.equal(protocolFee(10, 1000), 1);
  assert.equal(protocolFee(3, 1000), 0); // floor(0.3)
  assert.equal(protocolFee(100, 0), 0); // fee disabled
});

// ---- geoip stays off the boot path ----
// Importing geoip-lite synchronously reads 108,864,488 bytes of .dat files. That
// used to happen at API import time, on every start, for a lookup that only runs
// when a node registers. If someone reinstates the top-level import, this fails.
test("geoip-lite is not loaded until a public IP is actually looked up", () => {
  const loaded = (): boolean =>
    Object.keys(require.cache).some((p) => /[\\/]geoip-lite[\\/]/.test(p));
  assert.equal(loaded(), false, "geoip-lite was already loaded before the test");

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { countryFromIp } = require("../src/common/geoip") as {
    countryFromIp: (ip: string | null | undefined) => string | null;
  };
  assert.equal(loaded(), false, "importing the module must not pull the dataset in");

  // Private and empty addresses short-circuit, so they must not load it either.
  assert.equal(countryFromIp("127.0.0.1"), null);
  assert.equal(countryFromIp(""), null);
  assert.equal(loaded(), false, "a private address must not pull the dataset in");

  // A public address does, and still resolves correctly.
  assert.equal(countryFromIp("8.8.8.8"), "US");
  assert.equal(loaded(), true, "the dataset should be loaded once it is needed");
});

// ---- reasoning models must not think out loud in the answer ----
// DeepSeek R1 and Qwen 3 stream <think>…</think> as ordinary content through the
// plain OpenAI endpoint the bundled engine speaks. The tags arrive split across
// network chunks, which is where naive stripping breaks.
{
  const feed = (chunks: string[]): { visible: string; reasoning: string } => {
    let reasoning = "";
    const s = new ThinkSplitter((d) => {
      reasoning += d;
    });
    let visible = "";
    for (const c of chunks) visible += s.push(c);
    visible += s.end();
    return { visible, reasoning };
  };

  test("a whole think block is removed from the answer", () => {
    const r = feed(["<think>ragiono</think>", "Parigi"]);
    assert.equal(r.visible, "Parigi");
    assert.equal(r.reasoning, "ragiono");
  });

  test("tags split across chunks are still recognised", () => {
    const r = feed(["<th", "ink>segre", "to</thi", "nk>Madrid"]);
    assert.equal(r.visible, "Madrid");
    assert.equal(r.reasoning, "segreto");
  });

  test("text before and after the block both survive", () => {
    const r = feed(["ciao <think>x</think> mondo"]);
    assert.equal(r.visible, "ciao  mondo");
  });

  test("a model that never reasons is passed through untouched", () => {
    const r = feed(["Roma", " è", " la", " capitale"]);
    assert.equal(r.visible, "Roma è la capitale");
    assert.equal(r.reasoning, "");
  });

  test("a lone < is not swallowed", () => {
    const r = feed(["2 < 3"]);
    assert.equal(r.visible, "2 < 3");
  });

  test("an unclosed block never leaks into the answer", () => {
    // A truncated stream must not suddenly dump the scratchpad on the user.
    const r = feed(["<think>sto ancora pensando"]);
    assert.equal(r.visible, "");
    assert.equal(r.reasoning, "sto ancora pensando");
  });

  test("a dangling partial tag at the end is flushed as text", () => {
    const r = feed(["fine <thi"]);
    assert.equal(r.visible, "fine <thi");
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
