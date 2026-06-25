# Agent 00 — Bootstrap Report

**Date:** 2026-06-25 · **Spec:** v1.2 · **Toolchain:** node 24.12, pnpm 8.12.1, docker 29.1, git 2.53. Go NOT installed.

## What was created

```
root        package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json,
            .env / .env.example, .gitignore, docker-compose.yml (+ ai/chain profiles), README.md
apps/api    NestJS 10 boot (main.ts, app.module, ConfigModule), PrismaModule + PrismaService,
            HealthModule (/api/health, /health/db live; redis/storage/contracts/ai-router stubbed),
            prisma/schema.prisma  ← CONSOLIDATED v1.1 + all gap models, prisma/seed.ts
apps/web    Next.js 14 App Router (layout, landing page)
apps/workers/echo-worker        /worker/run contract impl + Dockerfile
apps/workers/embedding-worker   placeholder deterministic embedder (G1-testable)
apps/node-agent geo skeleton (cmd/neurion-node/main.go, go.mod) — build deferred (no Go)
packages/shared     zod types (PrivacyLevel, Lane, NodeTrustLevel)
packages/protocol   WS envelopes (node.hello, node.heartbeat, WorkerOutput)
packages/contracts  NRNToken.sol, ComputeRewardVault.sol, deploy-local.ts, hardhat.config.ts
infra/scripts       setup-ollama.ps1 (G3)
docs/architecture   verification-g1.md, privacy-g2.md, gaps-g5-g15.md (decisions)
docs/operations     this report
```

## Consolidated Prisma schema

v1.1 (15 models) + gap models: `JobVerification`, `GoldenTask` (G1); `NodeConfidentialityProfile`,
`NodeAttestation`, `NodeOperatorAgreement(+Acceptance)`, `ChatMessageRoute`, `OpenTierConsent` (G2);
`OwnerReputation`, `RegistrationChallenge`, `WorkspaceConfig`, enum `NodeLifecycle`,
`CreditLedger.idempotencyKey` + `@@unique([jobId,reason])` (G5); `RefreshToken` (G6);
`Attachment` (G7); `ChatMessage.linkedJob` relation (G9); `EmissionSchedule` (G12).
`ChatConversation.privacyLevel` defaults `VERIFIED_ONLY` (G2). `AI_PROVIDER_DEFAULT=openai_compatible` (G3).

## What works (verified)

| Check | Result |
|-------|--------|
| `pnpm install` (root workspace) | ✅ exit 0 |
| `prisma generate` | ✅ client v5.22 |
| `pnpm db:validate` (dotenv → root .env) | ✅ "schema is valid 🚀" |
| `pnpm --filter @neurion/api build` (nest) | ✅ dist/main.js |
| shared / protocol / both workers (tsc) | ✅ |
| echo.v1 worker run (`/worker/run` contract) | ✅ valid output.json |
| `pnpm --filter @neurion/contracts build` (hardhat) | ✅ 8 sol files, typechain |
| `pnpm --filter @neurion/web build` (next) | ✅ static pages |
| `docker compose config` | ✅ valid |
| docker compose up postgres/redis/minio | ✅ all healthy |
| `prisma migrate dev --name init` → Postgres | ✅ `20260625042215_init`, 30 tables, FKs valid |
| `pnpm db:seed` | ✅ workspace + 3 users + 2 ledger + 2 models |
| API boot + `GET /api/health` + `/api/health/db` | ✅ both `{"status":"ok"}` |

Note: `prisma migrate dev` must receive `--name` non-interactively (run via the package script with the flag, or `prisma` directly); without it the CLI prompts and hangs. If a migrate run is aborted, terminate its stale Postgres backend (it holds the migrate advisory lock) before retrying — else the next run fails P1002.

## Commands

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis minio
pnpm db:migrate        # first migration from consolidated schema
pnpm db:seed           # workspace + 3 users + config + models
pnpm dev               # turbo: api + web
docker compose --profile ai up -d ollama   # real chat (G3); then infra/scripts/setup-ollama.ps1
docker compose --profile chain up -d hardhat
```

## What remains (next agents)

- **Go toolchain** not installed → `apps/node-agent` is a skeleton; install Go 1.22 to build (Agent 06).
- **Agent 01** API auth/DB: register/login/logout/refresh (+ G6 RefreshToken rotation/reuse-detection), RBAC guards, AuditLog, admin dashboard, first `prisma migrate`.
- **Agent 02** chat + AI Router + SSE (+ G2 privacy pipeline, G3 real provider + loud mock, G8 estimator, G10 hold/settle).
- **Agents 03–05** node registry + WS gateway, realtime pool, grid queue (+ G1 verification service, G5 sybil controls, G11 EventBus).
- **Agents 07–14** real workers, credits/verification, web dashboard/chat UI, crypto backend + wallet (+ G12 emission, G14 custody), compliance docs, deploy, E2E.
- **web/contracts** are in default `pnpm build`; full `pnpm build` also builds them (verified individually).

Design decisions for every gap: `docs/architecture/` + memory.
