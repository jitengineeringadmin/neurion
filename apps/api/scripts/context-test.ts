/**
 * Regression suite for context compilation (AgentContextService.compile).
 *
 * This is the code that decides what the model actually sees, and it had no
 * tests at all. It also governs whether the engine can reuse its KV cache:
 * that reuse requires the compiled prompt PREFIX to be byte-identical from one
 * turn to the next, so "the same history compiles to the same bytes" is a
 * correctness property here, not a stylistic preference.
 *
 * Run: pnpm --filter @neurion/api test:context
 */
import "reflect-metadata";
import assert from "node:assert";
import { AgentContextService } from "../src/agent/agent-context.service";
import type { ChatMsg } from "../src/ai/providers/ai-provider.interface";

// compile() touches only config + modelRegistry; both are stubbed so the suite
// runs offline with no database.
const config = {
  get: (k: string) => ({ AI_AGENT_CONTEXT_TOKENS: "8192" })[k],
} as never;
const prisma = { modelRegistry: { findFirst: async () => null } } as never;
const svc = new AgentContextService(prisma, config);

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok   ${name}`);
    })
    .catch((e: Error) => {
      failed++;
      console.error(`  FAIL ${name}\n       ${e.message}`);
    });
}

const SYSTEM: ChatMsg = { role: "system", content: "You are Neurion." };

/** A history long enough to force the compression path. */
function history(turns: number): ChatMsg[] {
  const msgs: ChatMsg[] = [SYSTEM];
  for (let i = 0; i < turns; i++) {
    msgs.push({
      role: "user",
      content: `Domanda numero ${i}. ` + "contesto ".repeat(400),
    });
    msgs.push({
      role: "assistant",
      content: `Risposta numero ${i}. ` + "dettaglio ".repeat(400),
    });
  }
  return msgs;
}

/** How many leading messages two compilations agree on, byte for byte. */
function sharedPrefix(a: ChatMsg[], b: ChatMsg[]): number {
  let n = 0;
  while (
    n < a.length &&
    n < b.length &&
    a[n]!.role === b[n]!.role &&
    a[n]!.content === b[n]!.content
  )
    n++;
  return n;
}

void (async () => {
  await test("short history is returned untouched and uncompressed", async () => {
    const msgs: ChatMsg[] = [SYSTEM, { role: "user", content: "ciao" }];
    const out = await svc.compile(msgs, "test-model");
    assert.equal(out.compressed, false);
    assert.deepEqual(out.messages, msgs);
  });

  await test("compiling the same history twice is byte-identical", async () => {
    const msgs = history(30);
    const a = await svc.compile(msgs, "test-model");
    const b = await svc.compile(msgs, "test-model");
    assert.equal(
      a.messages.length,
      b.messages.length,
      "different message count",
    );
    assert.deepEqual(a.messages, b.messages);
  });

  await test("a long history does get compressed (the path under test is reached)", async () => {
    const out = await svc.compile(history(30), "test-model");
    assert.equal(
      out.compressed,
      true,
      "history was not long enough to compress",
    );
  });

  await test("the system prompt stays first", async () => {
    const out = await svc.compile(history(30), "test-model");
    assert.equal(out.messages[0]?.role, "system");
  });

  // The one that matters for cache reuse: appending a turn must not rewrite the
  // messages that came before it.
  await test("PREFISSO: appending a turn keeps the earlier messages identical", async () => {
    const base = history(30);
    const next: ChatMsg[] = [
      ...base,
      { role: "user", content: "Domanda nuova. " + "contesto ".repeat(400) },
      {
        role: "assistant",
        content: "Risposta nuova. " + "dettaglio ".repeat(400),
      },
    ];
    const a = await svc.compile(base, "test-model");
    const b = await svc.compile(next, "test-model");
    const shared = sharedPrefix(a.messages, b.messages);
    assert.ok(
      shared >= a.messages.length - 2,
      `only ${shared}/${a.messages.length} leading messages survived the new turn — ` +
        `the engine has to reprocess the whole prompt every turn`,
    );
  });

  // Compression is snapped to blocks, so a rebuild at a block boundary is the
  // intended cost — what must not happen is a rebuild on EVERY turn, which is
  // what the sliding window used to do (0 of 12 turns reused their prefix).
  await test("PREFISSO: most consecutive turns reuse the previous prefix", async () => {
    const TURNS = 12;
    let msgs = history(30);
    let prev = (await svc.compile(msgs, "test-model")).messages;
    let reused = 0;
    for (let turn = 0; turn < TURNS; turn++) {
      msgs = [
        ...msgs,
        { role: "user", content: `Turno ${turn}. ` + "contesto ".repeat(400) },
        {
          role: "assistant",
          content: `Esito ${turn}. ` + "dettaglio ".repeat(400),
        },
      ];
      const now = (await svc.compile(msgs, "test-model")).messages;
      if (sharedPrefix(prev, now) >= prev.length - 2) reused++;
      prev = now;
    }
    // Two messages per turn against a block of 8 means at most one rebuild
    // every four turns; anything worse means the anchoring is not holding.
    assert.ok(
      reused >= Math.floor(TURNS * 0.7),
      `only ${reused}/${TURNS} turns reused the prefix`,
    );
  });

  await test("estimatedTokens never exceeds the input budget after compilation", async () => {
    const out = await svc.compile(history(60), "test-model");
    assert.ok(
      out.estimatedTokens <= out.inputBudget,
      `${out.estimatedTokens} > ${out.inputBudget}`,
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
