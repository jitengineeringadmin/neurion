# Neurion

Distributed AI compute network: fast ChatGPT-like chat + distributed grid jobs + internal credits + NRN utility token.

Spec: [`NEURION_SPEC_Codex_IT_EN_v1.2.md`](NEURION_SPEC_Codex_IT_EN_v1.2.md). Architecture decisions: [`docs/architecture/`](docs/architecture/).

## Monorepo layout

```
apps/
  api/                NestJS API (REST + WS + SSE) + Prisma schema
  web/                Next.js dashboard + chat UI
  node-agent/         Go cross-platform node agent
  workers/            Dockerized job workers (echo, embedding, ...)
packages/
  shared/             shared TS types + zod schemas
  protocol/           node/job/chat protocol schemas
  contracts/          Solidity + Hardhat (NRN token, reward vault)
infra/                docker, nginx, systemd, scripts
docs/                 architecture (G1/G2/G3/G4/G5-G15), legal, token, ops
```

## Prerequisites

- Node.js >= 20, pnpm 8 (`corepack enable`)
- Docker (Postgres, Redis, MinIO; optional Hardhat, Ollama)
- Go (only for `apps/node-agent`)
- Ollama (real local chat model) — `infra/scripts/setup-ollama.ps1`

## Local run

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis minio
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Optional services:

```bash
docker compose --profile ai up -d ollama        # real Fallback-lane chat (G3)
docker compose --profile chain up -d hardhat     # local NRN chain
```

## Status (bootstrap — Agent 00)

Skeleton scaffolded: workspace, turbo, docker-compose, env, consolidated Prisma schema, API health module, contracts. See the build report / `docs/architecture/` for what is implemented vs remaining per Agent 01–14.
