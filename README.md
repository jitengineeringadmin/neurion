<div align="center">

# Neurion

### AI you own. That no one can switch off.

**Run AI privately on your own machine — chat, a coding agent, image & short video generation — offline and free.
Or share your idle power with the network, so the power belongs to everyone.**

[**⬇ Download**](https://neurionproject.org) · [neurionproject.org](https://neurionproject.org)

</div>

---

## The philosophy

If tomorrow OpenAI or Anthropic pull the plug, what do you do? With Neurion the power is yours — and, shared, it belongs to everyone.

- **🔒 Yours** — it runs on *your* PC. Your data never leaves it. No cloud account, no subscription, no one looking over your shoulder.
- **🔌 Unkillable** — open weights, already released, impossible to claw back. Fully offline. No company can deprecate, price out, or switch off what runs on your own machine.
- **🤝 Everyone's** — when your machine isn't enough, you borrow power from your peers, not from a corporation. Shared, the power is all of ours.

A sovereignty tool that is closed-source is a contradiction — so Neurion's client is **open source (AGPL-3.0)**: anyone can read it, verify that nothing phones home, self-host it, and fork it. It survives even if we don't.

## What it is

A one-click desktop app (Windows today; macOS & Linux coming) that bundles everything — database, local AI engine, and UI — so it *just works*, offline, with no setup:

- **Chat** with local open models (Qwen, Llama, Mistral, DeepSeek, Gemma…), including vision models that can see your images.
- **Code** — a Claude-Code-style agent that works inside your own folders, with reusable **Skills** and per-project rules.
- **Images & short video** generated locally (Stable Diffusion + Wan), with soundtrack.
- **The network** — turn your idle machine into a compute node, run verified work, and earn NRN. When you need more power than your PC has, borrow it from peers.

The app auto-detects your RAM and picks a model that fits — no "which model?" for non-technical users.

## Monorepo layout

```
apps/
  api/                NestJS API (REST + WS + SSE) + Prisma schema
  web/                Next.js dashboard + chat/code/media UI
  desktop/            Electron shell (bundles api + web + embedded Postgres)
  node-agent/         Go cross-platform node agent
  workers/            job workers (echo, embedding, ...)
packages/
  shared/ protocol/   shared TS types + zod schemas
  contracts/          Solidity + Hardhat (NRN token, reward vault)
infra/                nginx, systemd, deploy + release scripts
docs/                 architecture, legal, token, ops
```

## Build & run (developers)

Prerequisites: Node.js >= 20, pnpm 8 (`corepack enable`), and Ollama for local chat. Docker is optional (Postgres/Redis/MinIO for the server profile). Go only for `apps/node-agent`.

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis minio   # or use the Electron app's embedded Postgres
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Build the desktop app: `pnpm --filter @neurion/desktop pack` (produces an installer in `apps/desktop/dist-installer`).

## License & how this stays sustainable

Neurion is **open-core**:

- The **client** (this repo) is licensed **AGPL-3.0** — see [`LICENSE`](LICENSE). You may use, modify, self-host, and redistribute it freely; if you run a modified version as a network service, you must publish your changes under the same license. This is deliberate: it keeps the freedom sticky, so no one can take Neurion, close it, and resell it against the community.
- We monetize **convenience and scale, never the sovereignty**: managed hosting for those who don't want to self-host, the network fee, premium/at-scale features, and commercial licenses for anyone who wants to embed Neurion without the AGPL obligations (dual-licensing — we hold the copyright).

Contributions welcome. By contributing you agree your work is licensed under AGPL-3.0.

---

<div align="center"><sub>Built to improve the community's life: accessible AI, shared compute, value to those who create it.</sub></div>
