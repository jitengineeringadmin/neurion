import "reflect-metadata";
import assert from "node:assert";
import { PrismaClient } from "@prisma/client";
import { KnowledgePagingService } from "../src/chat/knowledge-paging.service";

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
const config = { get: () => undefined } as never;
const service = new KnowledgePagingService(prisma as never, config);

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`);
  }
}

async function main() {
  await prisma.$queryRaw`SELECT 1`;
  const workspace = await prisma.workspace.create({
    data: { name: "knowledge-test", slug: `knowledge-test-${Date.now()}` },
  });
  const user = await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: `knowledge-${Date.now()}@test.local`,
    },
  });
  const conversation = await prisma.chatConversation.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      title: "knowledge paging test",
    },
  });
  const chunks = Array.from({ length: 10 }, (_, index) => {
    const ordinary =
      `Chapter ${index + 1}. ` + "ordinary archive data. ".repeat(150);
    return index === 6
      ? `${ordinary} ZETA acceptance code is ORIONE-7429.`
      : ordinary;
  });

  await test("indexes a file into smaller persistent pages", async () => {
    const result = await service.indexFile(
      {
        sub: user.id,
        workspaceId: workspace.id,
        role: "USER",
        email: user.email,
      },
      conversation.id,
      {
        name: "manual.txt",
        type: "text/plain",
        size: chunks.join("\n").length,
        content: chunks[0] as string,
        chunks,
      },
    );
    assert.ok(result.totalChunks >= 8, String(result.totalChunks));
  });

  await test("retrieves only the page containing all significant terms", async () => {
    const result = await service.retrieve(
      user.id,
      conversation.id,
      "What is the ZETA acceptance code?",
      4,
    );
    assert.equal(result.selectedChunks, 1);
    assert.match(result.hits[0]?.content ?? "", /ORIONE-7429/);
  });

  await test("keeps broad whole-file requests on the existing full analyzer", () => {
    assert.equal(service.isBroadRequest("Riassumi tutto il file"), true);
    assert.equal(service.isBroadRequest("Qual e il codice ZETA?"), false);
  });

  await prisma.$transaction([
    prisma.chatConversation.delete({ where: { id: conversation.id } }),
    prisma.user.delete({ where: { id: user.id } }),
    prisma.workspace.delete({ where: { id: workspace.id } }),
  ]);
  await prisma.$disconnect();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
