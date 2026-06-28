import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // Never seed default accounts (with known passwords) into a production DB.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
    throw new Error('refusing to seed in production (set ALLOW_PROD_SEED=true to override)');
  }

  const workspace = await prisma.workspace.upsert({
    where: { slug: 'neurion-local' },
    update: {},
    create: { name: 'Neurion Local', slug: 'neurion-local' },
  });

  await prisma.workspaceConfig.upsert({
    where: { workspaceId: workspace.id },
    update: {},
    create: { workspaceId: workspace.id },
  });

  const users = [
    { email: process.env.SEED_ADMIN_EMAIL ?? 'admin@neurion.local', password: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!Neurion2026', role: 'SUPER_ADMIN' as const, credits: 1000 },
    { email: 'node@neurion.local', password: 'ChangeMe!Node2026', role: 'NODE_PROVIDER' as const, credits: 0 },
    { email: 'user@neurion.local', password: 'ChangeMe!User2026', role: 'USER' as const, credits: 100 },
    // protocol treasury — collects the take-rate (PROTOCOL_FEE_BPS) + slashing proceeds
    { email: 'treasury@neurion.local', password: process.env.SEED_TREASURY_PASSWORD ?? 'ChangeMe!Treasury2026', role: 'OPERATOR' as const, credits: 0 },
  ];

  for (const u of users) {
    const passwordHash = await argon2.hash(u.password);
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { workspaceId: workspace.id, email: u.email, passwordHash, role: u.role },
    });
    if (u.credits > 0) {
      const key = `seed:${user.id}`;
      const existing = await prisma.creditLedger.findUnique({ where: { idempotencyKey: key } });
      if (!existing) {
        await prisma.creditLedger.create({
          data: { userId: user.id, reason: 'SEED_GRANT', amount: u.credits, balanceAfter: u.credits, idempotencyKey: key },
        });
        await prisma.user.update({ where: { id: user.id }, data: { creditBalance: u.credits } });
      }
    }
  }

  await prisma.modelRegistry.upsert({
    where: { id: 'seed-mock-chat-small' },
    update: {},
    create: { id: 'seed-mock-chat-small', name: 'mock-chat-small', providerType: 'mock', modelRef: 'mock', mode: 'CHAT' },
  });
  await prisma.modelRegistry.upsert({
    where: { id: 'seed-ollama-llama' },
    update: {},
    create: { id: 'seed-ollama-llama', name: 'local-ollama-llama3.1-8b', providerType: 'openai_compatible', modelRef: 'llama3.1:8b', mode: 'CHAT' },
  });

  // eslint-disable-next-line no-console
  console.log('Seed complete: workspace', workspace.slug, '/ 3 users / 2 models');
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
