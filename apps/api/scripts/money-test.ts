/**
 * Money-path integration tests — credits + verification against a REAL Postgres,
 * because the security properties live in DB semantics: atomic conditional
 * decrement, unique idempotency keys, transactional rollback, claim races.
 *
 * Setup (once):
 *   DATABASE_URL=postgresql://neurion:neurion@localhost:5433/neurion_test \
 *     npx prisma db push --skip-generate
 * Run:
 *   pnpm --filter @neurion/api test:money
 * The DB url MUST contain "test" — the suite wipes tables.
 */
import "reflect-metadata";
import assert from "node:assert";
import { PrismaClient } from "@prisma/client";
import { CreditsService } from "../src/credits/credits.service";
import {
  VerificationService,
  JOB_REWARD,
} from "../src/jobs/verification.service";
import { TrustedExecutorService } from "../src/jobs/verification/trusted-executor.service";

const URL =
  process.env.DATABASE_URL_TEST ||
  `postgresql://neurion:neurion@localhost:${process.env.NEURION_PG_PORT ?? 5433}/neurion_test`;
if (!/test/i.test(URL)) {
  console.error(
    "refusing to run: DATABASE_URL_TEST must point at a *test* database",
  );
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: URL } } });

// Minimal ConfigService stand-in (the services only call .get)
const cfg = (env: Record<string, string> = {}) =>
  ({ get: (k: string) => env[k] }) as never;
const P = prisma as never; // PrismaService-compatible at runtime (same client surface)

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
}

async function reset(): Promise<void> {
  // children → parents (FK order)
  await prisma.knowledgeChunk.deleteMany();
  await prisma.knowledgeDocument.deleteMany();
  await prisma.contextSnapshot.deleteMany();
  await prisma.chatMessageRoute.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.chatConversation.deleteMany();
  await prisma.jobEvent.deleteMany();
  await prisma.jobVerification.deleteMany();
  await prisma.job.deleteMany();
  await prisma.creditLedger.deleteMany();
  await prisma.computeNode.deleteMany();
  await prisma.ownerReputation.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany();
}

let seq = 0;
async function ws() {
  return prisma.workspace.upsert({
    where: { slug: "money-test" },
    update: {},
    create: { name: "money-test", slug: "money-test" },
  });
}
async function mkUser(balance = 0) {
  const w = await ws();
  return prisma.user.create({
    data: {
      workspaceId: w.id,
      email: `u${seq++}@test.local`,
      creditBalance: balance,
    },
  });
}
async function mkNode(ownerUserId: string, over: Record<string, unknown> = {}) {
  const w = await ws();
  return prisma.computeNode.create({
    data: {
      workspaceId: w.id,
      ownerUserId,
      name: `n${seq++}`,
      nodeKeyHash: "h",
      ...over,
    } as never,
  });
}
async function mkJob(
  userId: string,
  nodeId: string,
  type: string,
  inputJson: unknown,
  over: Record<string, unknown> = {},
) {
  const w = await ws();
  return prisma.job.create({
    data: {
      workspaceId: w.id,
      userId,
      nodeId,
      type,
      status: "COMPLETED",
      inputJson: inputJson as never,
      costCredits: 1,
      ...over,
    } as never,
  });
}

async function main(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    console.error(
      `cannot reach the test database at ${URL} — is the local stack running?`,
    );
    process.exit(1);
  }
  await reset();

  // ============================ CreditsService ============================
  console.log("\nCreditsService (real Postgres)");
  const credits = new CreditsService(P, cfg());

  await test("grant adds balance + writes a ledger row", async () => {
    const u = await mkUser(0);
    const bal = await credits.grant(u.id, 100, "TEST_GRANT", "g1");
    assert.equal(bal, 100);
    const rows = await prisma.creditLedger.findMany({
      where: { userId: u.id },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 100);
    assert.equal(rows[0].balanceAfter, 100);
  });

  await test("grant is idempotent per key (retry does not double-credit)", async () => {
    const u = await mkUser(0);
    await credits.grant(u.id, 50, "TEST_GRANT", "dup-key");
    await assert.rejects(() =>
      credits.grant(u.id, 50, "TEST_GRANT", "dup-key"),
    );
    assert.equal(await credits.getBalance(u.id), 50); // increment rolled back with the tx
    assert.equal(
      await prisma.creditLedger.count({ where: { userId: u.id } }),
      1,
    );
  });

  await test("spend decrements and records a negative entry", async () => {
    const u = await mkUser(10);
    const bal = await credits.spend(u.id, 4, "TEST_SPEND", {
      idempotencyKey: "s1",
    });
    assert.equal(bal, 6);
    const row = await prisma.creditLedger.findFirst({
      where: { userId: u.id },
    });
    assert.equal(row?.amount, -4);
  });

  await test("spend rejects when balance is insufficient (nothing charged)", async () => {
    const u = await mkUser(3);
    await assert.rejects(() => credits.spend(u.id, 5, "TEST_SPEND"));
    assert.equal(await credits.getBalance(u.id), 3);
    assert.equal(
      await prisma.creditLedger.count({ where: { userId: u.id } }),
      0,
    );
  });

  await test("spend is idempotent per key (retry cannot double-charge)", async () => {
    const u = await mkUser(10);
    await credits.spend(u.id, 2, "TEST_SPEND", { idempotencyKey: "same" });
    await assert.rejects(() =>
      credits.spend(u.id, 2, "TEST_SPEND", { idempotencyKey: "same" }),
    );
    assert.equal(await credits.getBalance(u.id), 8); // charged exactly once
  });

  await test("10 concurrent spends of 1 with balance 5 → exactly 5 succeed, balance 0, never negative", async () => {
    const u = await mkUser(5);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        credits.spend(u.id, 1, "TEST_SPEND", { idempotencyKey: `c${i}` }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failures = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map(
        (result) =>
          `${result.reason?.code ?? ""}:${result.reason?.message ?? result.reason}`,
      );
    assert.equal(
      ok,
      5,
      `expected 5 successes, got ${ok}; failures: ${failures.join(" | ")}`,
    );
    assert.equal(await credits.getBalance(u.id), 0);
    const sum = await prisma.creditLedger.aggregate({
      where: { userId: u.id },
      _sum: { amount: true },
    });
    assert.equal(sum._sum.amount, -5);
  });

  await test("rewardWithFee splits gross between owner and treasury per PROTOCOL_REWARD_FEE_BPS", async () => {
    const owner = await mkUser(0);
    const treasury = await mkUser(0);
    const c = new CreditsService(
      P,
      cfg({
        PROTOCOL_REWARD_FEE_BPS: "1000",
        PROTOCOL_TREASURY_USER_ID: treasury.id,
      }),
    );
    const net = await c.rewardWithFee(owner.id, 100, "NODE_REWARD", "r1");
    assert.equal(net, 90);
    assert.equal(await c.getBalance(owner.id), 90);
    assert.equal(await c.getBalance(treasury.id), 10);
  });

  await test("rewardWithFee with fee disabled pays gross", async () => {
    const owner = await mkUser(0);
    const c = new CreditsService(P, cfg({ PROTOCOL_REWARD_FEE_BPS: "0" }));
    const net = await c.rewardWithFee(owner.id, 100, "NODE_REWARD", "r2");
    assert.equal(net, 100);
    assert.equal(await c.getBalance(owner.id), 100);
  });

  // ========================== VerificationService =========================
  console.log("\nVerificationService (slash / reward / race, real Postgres)");
  const executor = new TrustedExecutorService(cfg());
  const mkVerifier = (
    env: Record<string, string> = {},
    exec: TrustedExecutorService = executor,
  ) =>
    new VerificationService(P, new CreditsService(P, cfg(env)), exec, cfg(env));

  await test("sanity FAIL (wrong echo) → node SUSPENDED, job FAILED, user refunded", async () => {
    const requester = await mkUser(0);
    const owner = await mkUser(0);
    const node = await mkNode(owner.id);
    const job = await mkJob(
      requester.id,
      node.id,
      "echo.v1",
      { text: "hello" },
      { costCredits: 3 },
    );
    await mkVerifier().handleCompleted(job.id, {
      success: true,
      result: { echo: "WRONG" },
    });
    const j = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const n = await prisma.computeNode.findUniqueOrThrow({
      where: { id: node.id },
    });
    assert.equal(j.status, "FAILED");
    assert.match(j.errorMessage ?? "", /verification failed/);
    assert.equal(n.lifecycleState, "SUSPENDED");
    assert.equal(
      await new CreditsService(P, cfg()).getBalance(requester.id),
      3,
    ); // refund
    assert.equal(await new CreditsService(P, cfg()).getBalance(owner.id), 0); // no reward
  });

  await test("unsampled PASS → optimistic reward, NEVER NRN-eligible (C1)", async () => {
    const requester = await mkUser(0);
    const owner = await mkUser(0);
    const node = await mkNode(owner.id, {
      lifecycleState: "ACTIVE",
      reputation: 0.5,
    });
    const job = await mkJob(requester.id, node.id, "echo.v1", { text: "hi" });
    const rnd = Math.random;
    Math.random = () => 0.999; // above the ~7.5% sample rate → pass-by-trust
    try {
      await mkVerifier({ VERIFY_FORCE_SAMPLE: "false" }).handleCompleted(
        job.id,
        { success: true, result: { echo: "hi" } },
      );
    } finally {
      Math.random = rnd;
    }
    const j = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const n = await prisma.computeNode.findUniqueOrThrow({
      where: { id: node.id },
    });
    assert.equal(j.status, "REWARDED");
    assert.equal(j.nrnPayoutEligible, false); // optimistic never earns NRN
    assert.equal(j.grantedOptimistically, true);
    assert.equal(n.outstandingOptimisticCredits, JOB_REWARD["echo.v1"]);
    assert.equal(n.unverifiedJobCount, 1);
    assert.equal(n.reputation, 0.5); // C1: reputation must NOT move on unsampled passes
    assert.equal(
      await new CreditsService(P, cfg()).getBalance(owner.id),
      JOB_REWARD["echo.v1"],
    );
  });

  await test("sampled deep PASS → strict reward, NRN-eligible, reputation up", async () => {
    const requester = await mkUser(0);
    const owner = await mkUser(0);
    const node = await mkNode(owner.id, {
      lifecycleState: "ACTIVE",
      reputation: 0.5,
    });
    const job = await mkJob(requester.id, node.id, "echo.v1", { text: "ping" });
    await mkVerifier({ VERIFY_FORCE_SAMPLE: "true" }).handleCompleted(job.id, {
      success: true,
      result: { echo: "ping" },
    });
    const j = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const n = await prisma.computeNode.findUniqueOrThrow({
      where: { id: node.id },
    });
    assert.equal(j.status, "REWARDED");
    assert.equal(j.nrnPayoutEligible, true);
    assert.equal(j.grantedOptimistically, false);
    assert.ok(n.reputation > 0.5);
    assert.equal(n.verifiedJobCount, 1);
    assert.equal(
      await new CreditsService(P, cfg()).getBalance(owner.id),
      JOB_REWARD["echo.v1"],
    );
  });

  await test("sampled deep FAIL → slash + clawback of outstanding optimistic credits", async () => {
    const requester = await mkUser(0);
    const owner = await mkUser(5); // previously-granted optimistic rewards still in the wallet
    const node = await mkNode(owner.id, {
      lifecycleState: "ACTIVE",
      reputation: 0.5,
      outstandingOptimisticCredits: 5,
    });
    const job = await mkJob(
      requester.id,
      node.id,
      "echo.v1",
      { text: "x" },
      { costCredits: 2 },
    );
    // Cheating reference: sanity passes (echo === input) but the trusted re-exec disagrees.
    const cheatExec = {
      available: () => true,
      reference: async () => ({ echo: "DIFFERENT" }),
    } as unknown as TrustedExecutorService;
    await mkVerifier(
      { VERIFY_FORCE_SAMPLE: "true" },
      cheatExec,
    ).handleCompleted(job.id, { success: true, result: { echo: "x" } });
    const j = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const n = await prisma.computeNode.findUniqueOrThrow({
      where: { id: node.id },
    });
    assert.equal(j.status, "FAILED");
    assert.equal(n.lifecycleState, "SUSPENDED");
    assert.equal(n.outstandingOptimisticCredits, 0);
    assert.equal(await new CreditsService(P, cfg()).getBalance(owner.id), 0); // 5 clawed back
    assert.equal(
      await new CreditsService(P, cfg()).getBalance(requester.id),
      2,
    ); // refunded
  });

  await test("double completion (race) rewards exactly once", async () => {
    const requester = await mkUser(0);
    const owner = await mkUser(0);
    const node = await mkNode(owner.id, {
      lifecycleState: "ACTIVE",
      reputation: 0.5,
    });
    const job = await mkJob(requester.id, node.id, "echo.v1", { text: "once" });
    const v = mkVerifier({ VERIFY_FORCE_SAMPLE: "true" });
    const out = { success: true, result: { echo: "once" } };
    await Promise.allSettled([
      v.handleCompleted(job.id, out),
      v.handleCompleted(job.id, out),
    ]);
    assert.equal(
      await new CreditsService(P, cfg()).getBalance(owner.id),
      JOB_REWARD["echo.v1"],
    ); // once
    assert.equal(
      await prisma.jobVerification.count({ where: { jobId: job.id } }),
      1,
    );
    const rewards = await prisma.creditLedger.count({
      where: { userId: owner.id, reason: "NODE_REWARD" },
    });
    assert.equal(rewards, 1);
  });

  await test("image.v1: real PNG → provisional (score 0.5, paid, NOT NRN-eligible)", async () => {
    const requester = await mkUser(0);
    const owner = await mkUser(0);
    const node = await mkNode(owner.id, {
      lifecycleState: "ACTIVE",
      reputation: 0.5,
    });
    const job = await mkJob(
      requester.id,
      node.id,
      "image.v1",
      { prompt: "a cat" },
      { costCredits: 25 },
    );
    const png = "iVBORw0KGgo" + "A".repeat(200); // base64 of the PNG magic + payload
    await mkVerifier({ VERIFY_FORCE_SAMPLE: "true" }).handleCompleted(job.id, {
      success: true,
      result: { image: png },
    });
    const j = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(j.status, "REWARDED");
    assert.equal(j.verificationScore, 0.5);
    assert.equal(j.nrnPayoutEligible, false); // non-deterministic can't earn NRN
    assert.equal(
      await new CreditsService(P, cfg()).getBalance(owner.id),
      JOB_REWARD["image.v1"],
    );
  });

  await test("image.v1: junk instead of a PNG → slash + refund", async () => {
    const requester = await mkUser(0);
    const owner = await mkUser(0);
    const node = await mkNode(owner.id, {
      lifecycleState: "ACTIVE",
      reputation: 0.5,
    });
    const job = await mkJob(
      requester.id,
      node.id,
      "image.v1",
      { prompt: "a cat" },
      { costCredits: 25 },
    );
    await mkVerifier({ VERIFY_FORCE_SAMPLE: "true" }).handleCompleted(job.id, {
      success: true,
      result: { image: "not-a-png-".repeat(20) },
    });
    const j = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const n = await prisma.computeNode.findUniqueOrThrow({
      where: { id: node.id },
    });
    assert.equal(j.status, "FAILED");
    assert.equal(n.lifecycleState, "SUSPENDED");
    assert.equal(
      await new CreditsService(P, cfg()).getBalance(requester.id),
      25,
    );
    assert.equal(await new CreditsService(P, cfg()).getBalance(owner.id), 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

void main();
