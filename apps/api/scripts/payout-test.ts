/**
 * Payout money-path tests.
 *
 * Three defects lived here, all of which cost either the user or the protocol
 * real money and none of which any test covered:
 *   - a failed payout refunded the NET, silently keeping the fee on a payout
 *     that never happened
 *   - a confirmation that could not be observed was treated as a failure and
 *     refunded, even though the transaction was already on the chain and might
 *     still confirm — paying out twice
 *   - the KYC threshold was checked against one request at a time, so splitting
 *     a cash-out into smaller ones stayed under it forever
 *
 * Run: DATABASE_URL_TEST=postgresql://…/neurion_test pnpm --filter @neurion/api test:payout
 */
import "reflect-metadata";
import assert from "node:assert";
import { PrismaClient } from "@prisma/client";
import { CreditsService } from "../src/credits/credits.service";
import { TokenPayoutService } from "../src/crypto/token-payout.service";

const URL =
  process.env.DATABASE_URL_TEST ||
  "postgresql://neurion:neurion@localhost:5433/neurion_test";
if (!/test/i.test(URL)) {
  console.error("refusing to run: DATABASE_URL_TEST must point at a *test* database");
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
const P = prisma as never;
const cfg = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as never;

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

/** Chain stub: `mode` decides where in the send the failure lands. */
function vaultStub(mode: "ok" | "throw-on-send" | "throw-on-wait") {
  return {
    getFunction: () => async () => {
      if (mode === "throw-on-send") throw new Error("insufficient funds for gas");
      return {
        hash: "0xdeadbeef",
        wait: async () => {
          if (mode === "throw-on-wait") throw new Error("timeout waiting for confirmation");
          return { status: 1 };
        },
      };
    },
  };
}

function tokenConfig(mode: "ok" | "throw-on-send" | "throw-on-wait") {
  return {
    payoutsEnabled: true,
    chainId: 31337,
    creditToNrnWei: "1000000000000000000",
    signerVault: () => vaultStub(mode),
  } as never;
}

const emissionStub = { tryReserve: async () => true, release: async () => undefined } as never;
const auditStub = { log: async () => undefined } as never;

async function freshUser(credits: number, kyc: "KYC_APPROVED" | "KYC_REQUIRED" = "KYC_REQUIRED") {
  const ws = await prisma.workspace.findFirst();
  const workspaceId =
    ws?.id ?? (await prisma.workspace.create({ data: { name: "test", slug: "test" } })).id;
  return prisma.user.create({
    data: {
      email: `payout-${Date.now()}-${Math.round(Math.random() * 1e6)}@test.local`,
      passwordHash: "x",
      workspaceId,
      creditBalance: credits,
      walletAddress: "0x1111111111111111111111111111111111111111",
      kycStatus: kyc,
    },
  });
}

const balanceOf = async (id: string): Promise<number> =>
  (await prisma.user.findUniqueOrThrow({ where: { id }, select: { creditBalance: true } })).creditBalance;

void (async () => {
  // The treasury has to exist before the first collectFee call: without it the
  // take-rate silently resolves to zero, and a test that never charges a fee
  // cannot show that the fee is refunded.
  const ws0 = await prisma.workspace.findFirst();
  const wsId = ws0?.id ?? (await prisma.workspace.create({ data: { name: "test", slug: "test" } })).id;
  await prisma.user.upsert({
    where: { email: "treasury@neurion.local" },
    update: {},
    create: { email: "treasury@neurion.local", passwordHash: "x", workspaceId: wsId },
  });

  const credits = new CreditsService(P, cfg({ PROTOCOL_FEE_BPS: "1000" })); // 10% take-rate
  process.env.KYC_PAYOUT_THRESHOLD_CREDITS = "1000";
  process.env.KYC_PAYOUT_WINDOW_DAYS = "30";

  await test("a payout that never reaches the chain refunds the GROSS, fee included", async () => {
    const u = await freshUser(500);
    const svc = new TokenPayoutService(P, credits, tokenConfig("throw-on-send"), auditStub, emissionStub);
    await svc.requestPayout({ sub: u.id } as never, 200);

    const afterRequest = await balanceOf(u.id);
    assert.equal(afterRequest, 300, `expected 300 after spending 200, got ${afterRequest}`);

    await svc.processPayouts("admin");
    const afterFailure = await balanceOf(u.id);
    // 200 was taken, of which 20 went to the treasury as fee. Refunding the net
    // would leave the user at 480 and the protocol holding a fee for nothing.
    assert.equal(afterFailure, 500, `expected the full 500 back, got ${afterFailure}`);

    const p = await prisma.tokenPayout.findFirstOrThrow({ where: { userId: u.id } });
    assert.equal(p.status, "FAILED");
    assert.equal(p.grossCredits, 200);
    assert.ok(p.feeCredits > 0, "fee should have been recorded");
  });

  await test("SECURITY: a submitted payout is NOT refunded when confirmation is not observed", async () => {
    const u = await freshUser(500);
    const svc = new TokenPayoutService(P, credits, tokenConfig("throw-on-wait"), auditStub, emissionStub);
    await svc.requestPayout({ sub: u.id } as never, 200);
    const afterRequest = await balanceOf(u.id);

    await svc.processPayouts("admin");
    const after = await balanceOf(u.id);
    assert.equal(
      after,
      afterRequest,
      `balance must not change: the tokens may already be on-chain (was ${afterRequest}, now ${after})`,
    );

    const p = await prisma.tokenPayout.findFirstOrThrow({ where: { userId: u.id } });
    assert.equal(p.status, "SUBMITTED", "must stay SUBMITTED for reconciliation, not FAILED");
    assert.ok(p.txHash, "the transaction hash must be kept so the send can be reconciled");
    assert.ok(p.submittedAt, "submittedAt must mark the point of no return");
  });

  await test("a confirmed payout settles and is not refunded", async () => {
    const u = await freshUser(500);
    const svc = new TokenPayoutService(P, credits, tokenConfig("ok"), auditStub, emissionStub);
    await svc.requestPayout({ sub: u.id } as never, 200);
    await svc.processPayouts("admin");
    assert.equal(await balanceOf(u.id), 300);
    const p = await prisma.tokenPayout.findFirstOrThrow({ where: { userId: u.id } });
    assert.equal(p.status, "CONFIRMED");
  });

  await test("SECURITY: splitting a cash-out no longer stays under the KYC threshold", async () => {
    const u = await freshUser(5000);
    const svc = new TokenPayoutService(P, credits, tokenConfig("ok"), auditStub, emissionStub);
    // Four requests of 300 each: every one is below the 1000 limit on its own.
    for (let i = 0; i < 3; i++) await svc.requestPayout({ sub: u.id } as never, 300);
    await assert.rejects(
      () => svc.requestPayout({ sub: u.id } as never, 300),
      /KYC required/,
      "the fourth request takes the 30-day total to 1200 and must be refused",
    );
  });

  await test("a KYC-approved account is not subject to the threshold", async () => {
    const u = await freshUser(5000, "KYC_APPROVED");
    const svc = new TokenPayoutService(P, credits, tokenConfig("ok"), auditStub, emissionStub);
    for (let i = 0; i < 5; i++) await svc.requestPayout({ sub: u.id } as never, 300);
    const n = await prisma.tokenPayout.count({ where: { userId: u.id } });
    assert.equal(n, 5);
  });

  await test("a failed payout does not count towards the KYC window", async () => {
    const u = await freshUser(5000);
    const bad = new TokenPayoutService(P, credits, tokenConfig("throw-on-send"), auditStub, emissionStub);
    await bad.requestPayout({ sub: u.id } as never, 900);
    await bad.processPayouts("admin"); // -> FAILED, refunded
    const ok = new TokenPayoutService(P, credits, tokenConfig("ok"), auditStub, emissionStub);
    // The 900 was returned and never left the system, so it must not consume the allowance.
    await ok.requestPayout({ sub: u.id } as never, 900);
    const n = await prisma.tokenPayout.count({ where: { userId: u.id, status: { not: "FAILED" } } });
    assert.equal(n, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
})();
