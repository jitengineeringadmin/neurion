# NEURION — Software Specification & Build Plan v1.1
## Distributed AI Compute Network + Fast AI Chat + Internal Credits + NRN Utility Token
### Specifica operativa per sviluppo con agenti Codex / Operational build spec for Codex agents

**Version:** 1.1  
**Date:** 2026-06-24  
**Owner:** Giacomo Rossi  
**Project:** `neurion`  
**Primary language:** IT + EN  
**Execution target:** usable MVP, not presentation demo

---

# 0. Executive Summary / Sintesi

## IT
Neurion è una piattaforma software composta da:

1. **Neurion Web** — portale SaaS e interfaccia chat tipo ChatGPT.
2. **Neurion API** — backend centrale su VPS per utenti, nodi, job, crediti, wallet, token e amministrazione.
3. **Neurion Node** — programma installabile su PC/server degli utenti per condividere CPU/GPU.
4. **Neurion Workers** — container AI per job distribuiti: embedding, trascrizione, OCR, immagini, batch.
5. **Neurion Realtime Pool** — nodi caldi per chat veloce con modelli già caricati.
6. **Neurion Crypto Layer** — crediti interni + token utility `NRN` in testnet, pronto per produzione regolata.

Il punto fondamentale della v1.1 è la velocità: l’utente deve usare Neurion come una chat AI veloce, mentre la rete distribuita lavora dietro.

## EN
Neurion is a software platform made of:

1. **Neurion Web** — SaaS portal and ChatGPT-like AI chat interface.
2. **Neurion API** — central backend on VPS for users, nodes, jobs, credits, wallet, token and admin.
3. **Neurion Node** — installable client for users’ PCs/servers to share CPU/GPU.
4. **Neurion Workers** — AI containers for distributed jobs: embeddings, transcription, OCR, images, batch.
5. **Neurion Realtime Pool** — warm nodes for fast chat with preloaded models.
6. **Neurion Crypto Layer** — internal credits + `NRN` utility token on testnet, production-ready path.

The key point of v1.1 is speed: the user must experience Neurion as a fast AI chat, while the distributed network works underneath.

---

# 1. Product Vision / Visione prodotto

## IT
Neurion è la **Linux della potenza AI**: open source, distribuita, comunitaria, utile e monetizzabile.  
Non vende solo “GPU cloud”. Non è una shitcoin. Non è mining vuoto.  
È un sistema dove la potenza inutilizzata viene trasformata in AI accessibile.

**Frase prodotto:**

> Condividi potenza inutilizzata. Accedi all’AI. Guadagna crediti e token utility.

## EN
Neurion is the **Linux of AI compute**: open-source, distributed, community-powered, useful and monetizable.  
It is not just “GPU cloud”. It is not an empty coin. It is not useless mining.  
It turns idle compute power into accessible AI.

**Product sentence:**

> Share idle power. Access AI. Earn credits and utility tokens.

---

# 2. Non-Negotiable Product Requirements

## IT
La prima versione deve essere usabile realmente.

L’utente finale deve poter:

1. registrarsi;
2. aprire una chat tipo ChatGPT;
3. ricevere risposte veloci;
4. caricare file e creare job AI pesanti;
5. vedere costo stimato in crediti;
6. vedere stato job in tempo reale;
7. installare Neurion Node;
8. contribuire CPU/GPU;
9. guadagnare crediti;
10. collegare wallet;
11. ricevere reward NRN in testnet;
12. vedere storico, log e payout.

## EN
The first version must be genuinely usable.

The end user must be able to:

1. register;
2. open a ChatGPT-like interface;
3. receive fast answers;
4. upload files and create heavy AI jobs;
5. see estimated credit cost;
6. see job status in real time;
7. install Neurion Node;
8. contribute CPU/GPU;
9. earn credits;
10. connect wallet;
11. receive NRN testnet rewards;
12. view history, logs and payouts.

---

# 3. Core Architecture v1.1 — Three Lanes

Neurion must not send every chat message to random public nodes. That would be slow.  
Neurion uses **three lanes**.

```txt
User prompt / richiesta utente
        ↓
Neurion AI Router
        ↓
┌─────────────────────┬─────────────────────┬─────────────────────┐
│ FAST LANE            │ GRID LANE            │ FALLBACK LANE        │
│ Chat veloce          │ Job pesanti          │ Sempre disponibile   │
│ Warm realtime nodes  │ Distributed workers  │ Internal/cloud node  │
└─────────────────────┴─────────────────────┴─────────────────────┘
```

---

## 3.1 Fast Lane — Chat veloce / Fast Chat

### IT
La Fast Lane serve per la chat tipo ChatGPT.

Target prestazioni:

```txt
First token target: < 1.5 s
Typical short answer: 2–8 s
Streaming: required
Warm model: required
Cold model loading during chat: forbidden
```

Usa solo nodi:

```txt
- online stabili
- verificati o interni
- modello già caricato
- WebSocket persistente
- latenza bassa
- benchmark recente valido
```

### EN
Fast Lane is used for ChatGPT-like chat.

Performance targets:

```txt
First token target: < 1.5 s
Typical short answer: 2–8 s
Streaming: required
Warm model: required
Cold model loading during chat: forbidden
```

Only use nodes that are:

```txt
- stable online
- verified or internal
- model already loaded
- persistent WebSocket
- low latency
- recent valid benchmark
```

---

## 3.2 Grid Lane — Distributed Heavy Jobs

### IT
La Grid Lane è la rete tipo eMule/BOINC per job pesanti o asincroni.

Esempi:

```txt
- trascrizione audio lunga
- OCR
- embedding documenti
- analisi PDF multipli
- generazione immagini
- batch notturni
- video/rendering futuro
```

Qui va bene attendere 30 secondi, 2 minuti, 10 minuti.  
Questa è la corsia perfetta per server domestici, PC gamer, workstation aziendali.

### EN
Grid Lane is the eMule/BOINC-like network for heavy or asynchronous jobs.

Examples:

```txt
- long audio transcription
- OCR
- document embeddings
- multiple PDF analysis
- image generation
- overnight batch jobs
- future video/rendering
```

Waiting 30 seconds, 2 minutes or 10 minutes is acceptable here.  
This lane is perfect for home servers, gaming PCs and company workstations.

---

## 3.3 Fallback Lane — Always Available

### IT
La Fallback Lane evita che l’utente resti bloccato.

Quando Fast Lane o Grid Lane non sono disponibili, Neurion usa:

```txt
- nodo interno Neurion
- VPS/GPU dedicata
- provider OpenAI-compatible configurabile
- modello locale centralizzato
```

Il fallback deve essere automatico e loggato.

### EN
Fallback Lane prevents the user from getting stuck.

When Fast Lane or Grid Lane is unavailable, Neurion uses:

```txt
- internal Neurion node
- dedicated VPS/GPU
- configurable OpenAI-compatible provider
- centralized local model
```

Fallback must be automatic and logged.

---

# 4. User Experience / Esperienza utente

## 4.1 Main app

```txt
NEURION AI
────────────────────────────────────
[ Chat AI ]
[ Documenti / Documents ]
[ Immagini / Images ]
[ Audio ]
[ Job ]
[ Nodi / Nodes ]
[ Crediti / Credits ]
[ Wallet NRN ]
[ Admin ]
```

## 4.2 Chat behavior

### Example 1 — Fast chat

```txt
User:
Spiegami in breve cos'è Neurion.

Neurion:
Neurion è una rete distribuita che trasforma PC e server inutilizzati in potenza AI condivisa...
```

Route:

```txt
Chat request → AI Router → Fast Lane → streaming answer
```

### Example 2 — Heavy document job

```txt
User:
Analizza questi 40 PDF e trovami anomalie contrattuali.

Neurion:
Creo un job distribuito.
Tempo stimato: 4 minuti.
Costo stimato: 38 crediti.
Privacy: Verified EU Node.
Ti avviso appena il risultato è pronto.
```

Route:

```txt
Chat request → AI Router → Grid Lane → async job → result back to chat
```

### Example 3 — Fallback

```txt
User:
Rispondimi subito, è urgente.

Neurion:
Uso la corsia veloce dedicata.
```

Route:

```txt
Chat request → AI Router → Fast Lane unavailable → Fallback Lane → streaming answer
```

---

# 5. Monorepo Structure

```txt
neurion/
├─ apps/
│  ├─ api/                       # NestJS API + REST + WebSocket + SSE
│  ├─ web/                       # Next.js dashboard + AI Chat UI
│  ├─ node-agent/                # Go agent cross-platform
│  ├─ realtime-runner/           # optional local realtime model runner wrapper
│  └─ workers/
│     ├─ echo-worker/
│     ├─ embedding-worker/
│     ├─ whisper-worker/
│     ├─ ocr-worker/
│     └─ image-worker/
├─ packages/
│  ├─ shared/                    # shared TS types, zod schemas
│  ├─ protocol/                  # node/job/chat protocol schemas
│  ├─ contracts/                 # Solidity + Hardhat
│  ├─ ui/                        # shared UI components
│  └─ sdk/                       # future JS SDK
├─ infra/
│  ├─ docker/
│  ├─ nginx/
│  ├─ systemd/
│  └─ scripts/
├─ docs/
│  ├─ legal/
│  ├─ token/
│  ├─ api/
│  ├─ architecture/
│  └─ operations/
├─ docker-compose.yml
├─ pnpm-workspace.yaml
├─ turbo.json
├─ README.md
├─ NEURION_SPEC_Codex_IT_EN_v1.1.md
└─ .env.example
```

---

# 6. Technology Stack

## 6.1 Backend

```txt
Runtime: Node.js LTS
Framework: NestJS
API: REST + WebSocket + SSE streaming
DB: PostgreSQL
ORM: Prisma
Queue: Redis + BullMQ
Storage: MinIO/S3-compatible
Auth: JWT access + refresh cookie httpOnly
RBAC: SUPER_ADMIN, ADMIN, OPERATOR, USER, NODE_PROVIDER, COMPLIANCE
Audit: append-only AuditLog
Chat streaming: Server-Sent Events first, WebSocket later
```

## 6.2 Frontend

```txt
Framework: Next.js App Router
Language: TypeScript strict
UI: Tailwind + shadcn/ui
Wallet: wagmi + viem + SIWE
Charts: Recharts
State: TanStack Query
Streaming chat: SSE reader
Theme: dark industrial, clean, infrastructure-grade
```

## 6.3 Node Agent

```txt
Language: Go
OS: Windows, Linux, macOS
Execution: Docker sandbox for Grid jobs
Realtime mode: optional model runner endpoint
GPU detection: nvidia-smi
Connection: outbound WebSocket only
Config: neurion-node.yaml
Logs: local rotating logs + uploaded job logs
```

## 6.4 AI Runtime

MVP supports multiple providers behind one interface:

```txt
Provider types:
- mock                         # testing only
- local_ollama                 # local development
- openai_compatible            # any compatible inference server
- neurion_realtime_node         # warm distributed realtime node
- neurion_grid_worker           # async distributed worker
```

The API must not hardcode a single AI vendor.

## 6.5 Crypto

```txt
Contracts: Solidity
Tooling: Hardhat + TypeScript tests
Token: NRN ERC-20 utility token
Network MVP: Hardhat local + Sepolia testnet
Wallet auth: SIWE
Custody: non-custodial
Internal exchange: not implemented in MVP
CASP integration: provider abstraction only
```

---

# 7. Local Development Paths — Dev Workflow

## 7.1 Local path

```powershell
C:\jit-factory\projects\neurion
```

## 7.2 VPS path

```bash
/opt/jit-factory/projects/neurion
```

## 7.3 VPS IP

```txt
80.211.136.108
```

## 7.4 Commands

```powershell
cd C:\jit-factory\projects
.\Plan-JitApp.ps1 -Name neurion
.\Create-JitApp.ps1 -Name neurion
cd C:\jit-factory\projects\neurion
codexp neurion
.\Sync-JitAppToVps.ps1 -Name neurion
.\Deploy-JitApp.ps1 -Name neurion
.\Check-JitAppRuntime.ps1 -Name neurion
```

---

# 8. Environment

```env
NODE_ENV=development

# Ports
NEURION_API_PORT=8091
NEURION_WEB_PORT=3091
POSTGRES_PORT=5432
REDIS_PORT=6379
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001
HARDHAT_PORT=8545

# Database
DATABASE_URL=postgresql://neurion:neurion@localhost:5432/neurion

# Redis
REDIS_URL=redis://localhost:6379

# Storage
S3_ENDPOINT=http://localhost:9000
S3_REGION=eu-south-1
S3_BUCKET=neurion
S3_ACCESS_KEY=neurion
S3_SECRET_KEY=neurion-secret
S3_FORCE_PATH_STYLE=true

# Auth
JWT_ACCESS_SECRET=change-me-access
JWT_REFRESH_SECRET=change-me-refresh
COOKIE_DOMAIN=localhost

# Node Gateway
NODE_WS_URL=ws://localhost:8091/ws/nodes

# Chat / AI Router
AI_DEFAULT_LANE=fast
AI_ENABLE_FALLBACK=true
AI_FAST_FIRST_TOKEN_TARGET_MS=1500
AI_PROVIDER_DEFAULT=mock
AI_OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
AI_OPENAI_COMPATIBLE_API_KEY=local-dev
AI_DEFAULT_CHAT_MODEL=llama3.1:8b
AI_DEFAULT_SMALL_MODEL=phi3:mini
AI_STREAM_TIMEOUT_MS=60000
AI_GRID_JOB_THRESHOLD_TOKENS=6000
AI_GRID_FILE_THRESHOLD_MB=5

# Crypto
CHAIN_ID=31337
RPC_URL=http://127.0.0.1:8545
NRN_TOKEN_ADDRESS=
COMPUTE_REWARD_VAULT_ADDRESS=
REWARD_SIGNER_PRIVATE_KEY=
CREDIT_TO_NRN_WEI=100000000000000000

# Admin seed
SEED_ADMIN_EMAIL=admin@neurion.local
SEED_ADMIN_PASSWORD=ChangeMe!Neurion2026
```

---

# 9. Core Database Model

Codex must implement Prisma schema with these entities.

## 9.1 Workspace, User, Node, Job, Credits, Token

```prisma
model Workspace {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  users     User[]
  nodes     ComputeNode[]
  jobs      Job[]
  chats     ChatConversation[]
}

model User {
  id             String   @id @default(cuid())
  workspaceId    String
  email          String   @unique
  passwordHash   String?
  displayName    String?
  role           UserRole @default(USER)
  status         UserStatus @default(ACTIVE)
  walletAddress  String?
  kycStatus      KycStatus @default(KYC_NOT_REQUIRED)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  workspace      Workspace @relation(fields: [workspaceId], references: [id])
  nodes          ComputeNode[]
  jobs           Job[]
  chats          ChatConversation[]
  creditLedger   CreditLedger[]
  tokenPayouts   TokenPayout[]
}

enum UserRole {
  SUPER_ADMIN
  ADMIN
  OPERATOR
  USER
  NODE_PROVIDER
  COMPLIANCE
}

enum UserStatus {
  ACTIVE
  DISABLED
  PENDING
}

enum KycStatus {
  KYC_NOT_REQUIRED
  KYC_REQUIRED
  KYC_PENDING
  KYC_APPROVED
  KYC_REJECTED
  PAYOUT_BLOCKED
}

model ComputeNode {
  id                  String   @id @default(cuid())
  workspaceId          String
  ownerUserId          String
  name                String
  nodeKeyHash          String
  status              NodeStatus @default(OFFLINE)
  trustLevel           NodeTrustLevel @default(COMMUNITY)
  regionCode           String?
  os                  String?
  arch                String?
  cpuModel            String?
  cpuCores            Int?
  ramMb               Int?
  gpuVendor           String?
  gpuModel            String?
  gpuMemoryMb         Int?
  dockerAvailable     Boolean @default(false)
  nvidiaAvailable     Boolean @default(false)
  maxConcurrentJobs   Int @default(1)
  supportedModes      String[] @default([]) // grid, realtime, hybrid
  supportedJobTypes   String[] @default([])
  loadedModels        String[] @default([])
  avgFirstTokenMs     Int?
  avgTokensPerSecond  Float?
  reputationScore     Float @default(0)
  totalJobs           Int @default(0)
  successfulJobs      Int @default(0)
  failedJobs          Int @default(0)
  lastSeenAt          DateTime?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  workspace           Workspace @relation(fields: [workspaceId], references: [id])
  owner               User @relation(fields: [ownerUserId], references: [id])
  jobs                Job[]
  heartbeats          NodeHeartbeat[]
  realtimeSessions    RealtimeSession[]
}

enum NodeStatus {
  OFFLINE
  ONLINE
  BUSY
  DEGRADED
  DISABLED
  BANNED
}

enum NodeTrustLevel {
  COMMUNITY
  VERIFIED
  ENTERPRISE
  INTERNAL
}

model NodeHeartbeat {
  id          String   @id @default(cuid())
  nodeId      String
  cpuLoad     Float?
  ramUsedMb   Int?
  gpuLoad     Float?
  gpuTempC    Float?
  freeDiskMb  Int?
  firstTokenMs Int?
  tokensPerSecond Float?
  activeRealtimeSessions Int?
  createdAt   DateTime @default(now())

  node        ComputeNode @relation(fields: [nodeId], references: [id])
}
```

## 9.2 Jobs

```prisma
model Job {
  id              String   @id @default(cuid())
  workspaceId      String
  userId          String
  nodeId          String?
  chatMessageId   String?
  type            String
  lane            JobLane @default(GRID)
  status          JobStatus @default(PENDING)
  priority        Int @default(5)
  privacyLevel    JobPrivacyLevel @default(PUBLIC)
  inputObjectKey  String?
  outputObjectKey String?
  inputJson       Json?
  outputJson      Json?
  errorMessage    String?
  costCredits     Int @default(0)
  rewardCredits   Int @default(0)
  rewardTokenWei  String?
  verificationScore Float?
  assignedAt      DateTime?
  startedAt       DateTime?
  completedAt     DateTime?
  verifiedAt      DateTime?
  rewardedAt      DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  workspace       Workspace @relation(fields: [workspaceId], references: [id])
  user            User @relation(fields: [userId], references: [id])
  node            ComputeNode? @relation(fields: [nodeId], references: [id])
  events          JobEvent[]
}

enum JobLane {
  FAST
  GRID
  FALLBACK
}

enum JobStatus {
  PENDING
  ASSIGNED
  ACCEPTED
  RUNNING
  COMPLETED
  VERIFIED
  REWARDED
  FAILED
  RETRYING
  CANCELLED
  EXPIRED
}

enum JobPrivacyLevel {
  PUBLIC
  EU_ONLY
  VERIFIED_ONLY
  ENTERPRISE_ONLY
  INTERNAL_ONLY
}

model JobEvent {
  id        String   @id @default(cuid())
  jobId     String
  type      String
  message   String?
  data      Json?
  createdAt DateTime @default(now())

  job       Job @relation(fields: [jobId], references: [id])
}
```

## 9.3 Chat / AI Router

```prisma
model ChatConversation {
  id          String   @id @default(cuid())
  workspaceId String
  userId      String
  title       String?
  mode        ChatMode @default(AUTO)
  privacyLevel JobPrivacyLevel @default(PUBLIC)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  user        User @relation(fields: [userId], references: [id])
  messages    ChatMessage[]
}

enum ChatMode {
  AUTO
  FAST
  GRID
  PRIVATE
}

model ChatMessage {
  id              String   @id @default(cuid())
  conversationId  String
  role            ChatRole
  content         String
  laneUsed        JobLane?
  modelUsed       String?
  providerUsed    String?
  routingDecision Json?
  tokenUsage      Json?
  costCredits     Int @default(0)
  linkedJobId      String?
  createdAt       DateTime @default(now())

  conversation     ChatConversation @relation(fields: [conversationId], references: [id])
}

enum ChatRole {
  SYSTEM
  USER
  ASSISTANT
  TOOL
}

model ModelRegistry {
  id              String   @id @default(cuid())
  name            String
  providerType    String
  modelRef        String
  mode            ModelMode
  contextTokens   Int?
  supportsStream  Boolean @default(true)
  supportsTools   Boolean @default(false)
  requiresGpu     Boolean @default(false)
  enabled         Boolean @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

enum ModelMode {
  CHAT
  EMBEDDING
  TRANSCRIPTION
  IMAGE
  OCR
}

model RealtimeSession {
  id             String   @id @default(cuid())
  nodeId          String?
  userId          String
  model           String
  status          RealtimeSessionStatus @default(OPEN)
  firstTokenMs    Int?
  tokensPerSecond Float?
  startedAt       DateTime @default(now())
  endedAt         DateTime?

  node            ComputeNode? @relation(fields: [nodeId], references: [id])
}

enum RealtimeSessionStatus {
  OPEN
  CLOSED
  FAILED
  FALLBACK_USED
}
```

## 9.4 Credits, Token, Audit

```prisma
model CreditLedger {
  id            String   @id @default(cuid())
  userId        String
  reason        String
  amount        Int
  balanceAfter  Int
  jobId         String?
  chatMessageId String?
  createdAt     DateTime @default(now())

  user          User @relation(fields: [userId], references: [id])
}

model TokenPayout {
  id              String   @id @default(cuid())
  userId          String
  jobId           String?
  walletAddress   String
  tokenSymbol     String @default("NRN")
  amountWei       String
  chainId         Int
  txHash          String?
  status          PayoutStatus @default(PENDING)
  errorMessage    String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user            User @relation(fields: [userId], references: [id])
}

enum PayoutStatus {
  PENDING
  SUBMITTED
  CONFIRMED
  FAILED
  CANCELLED
  BLOCKED
}

model WalletNonce {
  id        String   @id @default(cuid())
  address   String
  nonce     String
  used      Boolean @default(false)
  expiresAt DateTime
  createdAt DateTime @default(now())
}

model AuditLog {
  id          String   @id @default(cuid())
  workspaceId String?
  actorUserId String?
  action      String
  entityType  String?
  entityId    String?
  ipAddress   String?
  userAgent   String?
  data        Json?
  createdAt   DateTime @default(now())
}

model ComplianceRecord {
  id          String   @id @default(cuid())
  userId      String?
  type        String
  status      String
  data        Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

---

# 10. API Specification

## 10.1 Auth

```http
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
POST /api/auth/refresh
```

## 10.2 Chat AI

```http
POST /api/chat/conversations
GET  /api/chat/conversations
GET  /api/chat/conversations/:id
POST /api/chat/conversations/:id/messages
GET  /api/chat/conversations/:id/messages
POST /api/chat/stream
POST /api/chat/estimate
```

### Create chat message

```json
{
  "conversationId": "conv_123",
  "message": "Riassumi questo testo in 5 punti",
  "mode": "AUTO",
  "privacyLevel": "PUBLIC",
  "attachments": [],
  "preferredModel": "auto"
}
```

### Stream response

Endpoint:

```http
POST /api/chat/stream
Accept: text/event-stream
```

SSE events:

```txt
event: routing
data: {"lane":"FAST","provider":"neurion_realtime_node","model":"llama-3.1-8b"}

event: token
data: {"text":"Neurion"}

event: token
data: {"text":" è"}

event: final
data: {"messageId":"msg_123","costCredits":2,"firstTokenMs":820}

event: error
data: {"message":"fallback used"}
```

## 10.3 Models

```http
GET  /api/models
POST /api/admin/models
PATCH /api/admin/models/:id
POST /api/admin/models/:id/enable
POST /api/admin/models/:id/disable
```

## 10.4 Nodes

```http
POST /api/nodes/register
GET  /api/nodes
GET  /api/nodes/:id
PATCH /api/nodes/:id
POST /api/nodes/:id/disable
POST /api/nodes/:id/enable
GET  /api/nodes/:id/heartbeats
GET  /api/nodes/:id/jobs
POST /api/nodes/:id/benchmark
```

## 10.5 Node WebSocket

```txt
WS /ws/nodes
```

Client → Server:

```json
{
  "type": "node.hello",
  "nodeId": "node_123",
  "nodeKey": "secret",
  "agentVersion": "0.1.0",
  "capabilities": {
    "modes": ["grid", "realtime"],
    "os": "windows",
    "arch": "amd64",
    "cpuCores": 16,
    "ramMb": 32768,
    "gpuVendor": "nvidia",
    "gpuModel": "RTX 4070",
    "gpuMemoryMb": 12288,
    "dockerAvailable": true,
    "nvidiaAvailable": true,
    "loadedModels": ["llama-3.1-8b"],
    "avgFirstTokenMs": 780,
    "avgTokensPerSecond": 42
  }
}
```

```json
{
  "type": "node.heartbeat",
  "nodeId": "node_123",
  "metrics": {
    "cpuLoad": 22.5,
    "ramUsedMb": 9200,
    "gpuLoad": 10.0,
    "gpuTempC": 55,
    "freeDiskMb": 240000,
    "activeRealtimeSessions": 1,
    "tokensPerSecond": 38.5
  }
}
```

Grid job messages:

```json
{ "type": "job.accepted", "jobId": "job_123" }
{ "type": "job.started", "jobId": "job_123" }
{ "type": "job.completed", "jobId": "job_123", "outputJson": {"result":"ok"} }
{ "type": "job.failed", "jobId": "job_123", "errorMessage": "worker failed" }
```

Realtime chat messages:

```json
{
  "type": "realtime.chat.request",
  "requestId": "rt_123",
  "model": "llama-3.1-8b",
  "messages": [
    {"role":"user", "content":"Ciao"}
  ],
  "stream": true,
  "timeoutMs": 60000
}
```

```json
{ "type": "realtime.chat.token", "requestId": "rt_123", "text": "Ciao" }
{ "type": "realtime.chat.done", "requestId": "rt_123", "usage": {"tokens": 120} }
{ "type": "realtime.chat.error", "requestId": "rt_123", "message": "model unavailable" }
```

Server → Client:

```json
{
  "type": "job.assign",
  "job": {
    "id": "job_123",
    "type": "embedding.v1",
    "inputJson": {"text":"hello"},
    "containerImage": "neurion/embedding-worker:0.1.0",
    "timeoutSec": 300,
    "maxMemoryMb": 2048,
    "requiresGpu": false
  }
}
```

## 10.6 Jobs

```http
POST /api/jobs
GET  /api/jobs
GET  /api/jobs/:id
POST /api/jobs/:id/cancel
GET  /api/jobs/:id/events
GET  /api/jobs/:id/output
```

## 10.7 Credits

```http
GET /api/credits/balance
GET /api/credits/ledger
POST /api/admin/credits/adjust
```

## 10.8 Wallet / Crypto

```http
POST /api/wallet/nonce
POST /api/wallet/verify
POST /api/wallet/disconnect
GET  /api/wallet/me
GET  /api/token/config
GET  /api/token/payouts
POST /api/token/request-payout
POST /api/token/admin/process-payouts
GET  /api/token/payouts/:id
```

## 10.9 Admin

```http
GET  /api/admin/dashboard
GET  /api/admin/users
PATCH /api/admin/users/:id
GET  /api/admin/nodes
PATCH /api/admin/nodes/:id/trust-level
GET  /api/admin/jobs
GET  /api/admin/audit
GET  /api/admin/compliance
POST /api/admin/compliance/:userId/block-payouts
POST /api/admin/compliance/:userId/unblock-payouts
```

---

# 11. AI Router

## 11.1 Router responsibilities

```txt
- classify request
- estimate cost
- choose lane
- select model
- select node/provider
- stream response
- create async job when needed
- fallback automatically
- write audit/routing logs
```

## 11.2 Lane decision rules

```txt
Use FAST when:
- text-only chat
- small context
- no large files
- user expects immediate answer
- warm realtime node exists

Use GRID when:
- file > threshold
- long audio/video
- batch operation
- image generation
- OCR
- large embeddings
- expected execution > 15 seconds

Use FALLBACK when:
- Fast Lane unavailable
- selected node times out
- user selected urgent mode
- no grid node available
- model not loaded in realtime pool
```

## 11.3 Pseudocode

```ts
async function routeAiRequest(req: AiRequest): Promise<RouteDecision> {
  const estimate = await estimator.estimate(req);

  if (req.mode === "GRID" || estimate.isHeavy) {
    return gridLane.select(req, estimate);
  }

  const realtimeNode = await realtimePool.findWarmNode({
    model: estimate.preferredModel,
    privacyLevel: req.privacyLevel,
    maxFirstTokenMs: env.AI_FAST_FIRST_TOKEN_TARGET_MS,
  });

  if (realtimeNode) {
    return { lane: "FAST", provider: "neurion_realtime_node", nodeId: realtimeNode.id };
  }

  if (env.AI_ENABLE_FALLBACK) {
    return { lane: "FALLBACK", provider: env.AI_PROVIDER_DEFAULT };
  }

  return gridLane.select(req, estimate);
}
```

---

# 12. Neurion Node Agent v1.1

## 12.1 Modes

```txt
GRID:
  executes async containerized jobs.

REALTIME:
  keeps one or more models warm and answers streamed chat requests.

HYBRID:
  can do both, with priority rules.
```

## 12.2 Local config

```yaml
node:
  name: "Giacomo Home Server"
  apiUrl: "http://localhost:8091"
  nodeId: ""
  nodeKey: ""
  modes:
    - "grid"
    - "realtime"
  maxConcurrentJobs: 1
  maxRealtimeSessions: 1
  allowGpu: true
  allowCpu: true
  workingDir: "./neurion-work"
  allowedJobTypes:
    - "echo.v1"
    - "embedding.v1"
    - "transcription.v1"
  schedule:
    enabled: false
    from: "23:00"
    to: "07:00"
  limits:
    maxCpuPercent: 80
    maxGpuPercent: 80
    maxGpuTempC: 78
    maxPowerWatts: 450
    maxJobSeconds: 1800
    maxDiskMb: 50000
realtime:
  enabled: true
  provider: "openai_compatible"
  baseUrl: "http://localhost:11434/v1"
  apiKey: "local-dev"
  models:
    - "llama3.1:8b"
  warmupOnStart: true
  benchmarkOnStart: true
security:
  dockerNetworkDisabledByDefault: true
  allowNetworkForJobTypes:
    - "embedding.v1"
logging:
  level: "info"
  uploadJobLogs: true
```

## 12.3 Commands

```bash
neurion-node register --api http://localhost:8091 --name "Local Test Node"
neurion-node start --config neurion-node.yaml
neurion-node status
neurion-node benchmark
neurion-node warmup --model llama3.1:8b
neurion-node test-job echo.v1
neurion-node test-chat "ciao, rispondi in breve"
neurion-node update
```

## 12.4 Agent responsibilities

```txt
- register node
- store node credentials locally
- detect CPU/RAM/GPU/Docker/NVIDIA
- detect local realtime model endpoint
- warm up configured models
- benchmark first-token and tokens/sec
- connect outbound WebSocket to API
- send node.hello
- send heartbeat every 10 seconds
- receive grid job assignment
- run worker container
- collect output
- report completion
- receive realtime chat request
- stream tokens back to API
- enforce CPU/GPU/temp/power limits
- clean temporary files
```

---

# 13. Workers

## 13.1 Standard contract

Every worker container accepts:

```bash
/worker/run --input /job/input.json --output /job/output.json
```

Output:

```json
{
  "success": true,
  "result": {},
  "metrics": {
    "startedAt": "2026-06-24T10:00:00Z",
    "completedAt": "2026-06-24T10:00:02Z",
    "durationMs": 2000,
    "cpuMs": 1200,
    "gpuMs": 0,
    "memoryPeakMb": 256
  }
}
```

## 13.2 MVP workers

```txt
echo.v1:
  image: neurion/echo-worker:0.1.0
  purpose: full pipeline validation

embedding.v1:
  image: neurion/embedding-worker:0.1.0
  purpose: text embedding

transcription.v1:
  image: neurion/whisper-worker:0.1.0
  purpose: audio transcription
  sprint: second sprint

ocr.v1:
  image: neurion/ocr-worker:0.1.0
  purpose: document OCR
  sprint: second/third sprint
```

---

# 14. Scheduler and Routing

## 14.1 Grid node score

```txt
score =
  availability_score * 0.25 +
  capability_score   * 0.25 +
  reputation_score   * 0.25 +
  locality_score     * 0.10 +
  cost_score         * 0.10 +
  freshness_score    * 0.05
```

## 14.2 Realtime node score

```txt
score =
  warm_model_score       * 0.30 +
  first_token_score      * 0.25 +
  tokens_per_sec_score   * 0.15 +
  reputation_score       * 0.15 +
  latency_score          * 0.10 +
  load_score             * 0.05
```

## 14.3 Hard filters

```txt
- node online
- not disabled/banned
- required mode supported
- required job type supported
- required model loaded for realtime
- enough RAM/GPU
- privacy level satisfied
- trust level satisfied
- temperature below limit
- active sessions below limit
```

## 14.4 Privacy routing

```txt
PUBLIC:
  community nodes allowed.

EU_ONLY:
  only nodes marked with EU region.

VERIFIED_ONLY:
  verified nodes only.

ENTERPRISE_ONLY:
  enterprise nodes only.

INTERNAL_ONLY:
  Neurion internal nodes only.
```

---

# 15. Credits

## 15.1 Internal unit

```txt
NCU = Neurion Compute Unit
```

## 15.2 Credit rules

```txt
- credits are internal platform units
- earned after verified compute
- spent to use AI jobs/chat
- stored in append-only ledger
- balance is derived from ledger
- admin adjustments require audit log
```

## 15.3 Spend defaults

```json
{
  "chat.fast.small": 2,
  "chat.fast.medium": 5,
  "chat.fallback.small": 3,
  "echo.v1": 1,
  "embedding.v1": 5,
  "transcription.v1": 20,
  "ocr.v1": 15,
  "image.v1": 25
}
```

## 15.4 Reward defaults

```json
{
  "echo.v1": 1,
  "embedding.v1": 3,
  "transcription.v1": 10,
  "ocr.v1": 8,
  "realtime.chat.minute": 4
}
```

## 15.5 Reward formula

```txt
rewardCredits =
  baseReward
  * verificationMultiplier
  * reputationMultiplier
  * demandMultiplier
  * realtimePerformanceMultiplier
  - penalty
```

---

# 16. Crypto Layer — NRN Token

## 16.1 Token identity

```txt
Name: Neurion
Symbol: NRN
Decimals: 18
Standard: ERC-20
MVP network: Hardhat local
Public testnet: Sepolia
Production: after legal/compliance/sign-off package
```

## 16.2 Utility

## IT
NRN serve per:

1. pagare compute AI;
2. premiare nodi per compute utile verificato;
3. accedere a job premium;
4. finanziare nodi pubblici;
5. sostenere grant open-source;
6. abilitare governance tecnica futura.

## EN
NRN is used to:

1. pay for AI compute;
2. reward nodes for verified useful compute;
3. access premium jobs;
4. fund public nodes;
5. support open-source grants;
6. enable future technical governance.

## 16.3 Token principles

```txt
- utility token
- no equity
- no dividend
- no guaranteed return
- no internal exchange in MVP
- no custody of user private keys
- rewards only for verified useful compute
- payout can be blocked by compliance/admin status
```

## 16.4 Tokenomics default

```txt
Total max supply: 1,000,000,000 NRN

Compute Rewards Pool:      40%
Ecosystem / Grants:        20%
Treasury / Operations:     15%
Team / Founders:           15%
Liquidity / Market Ops:     5%
Advisors / Partners:        5%
```

## 16.5 Vesting

```txt
Team / Founders:
  4 years vesting
  1 year cliff

Advisors / Partners:
  2 years vesting
  6 months cliff

Compute Rewards:
  emission over 8 years
  released by verified useful compute

Treasury:
  multisig controlled in production
```

## 16.6 MVP payout model

```txt
Phase A:
  internal credits only

Phase B:
  local Hardhat NRN payouts

Phase C:
  Sepolia NRN payouts

Phase D:
  production NRN with legal/token/compliance package
```

## 16.7 Conversion MVP

```txt
1 credit = 0.1 NRN testnet
```

```ts
export const CREDIT_TO_NRN_WEI = BigInt("100000000000000000"); // 0.1 NRN
```

---

# 17. Smart Contracts

## 17.1 Contract package

```txt
packages/contracts/
├─ contracts/
│  ├─ NRNToken.sol
│  ├─ ComputeRewardVault.sol
│  └─ VestingVault.sol
├─ scripts/
│  ├─ deploy-local.ts
│  ├─ deploy-sepolia.ts
│  └─ mint-test-rewards.ts
├─ test/
│  ├─ NRNToken.test.ts
│  ├─ ComputeRewardVault.test.ts
│  └─ VestingVault.test.ts
├─ hardhat.config.ts
└─ package.json
```

## 17.2 NRNToken.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract NRNToken is ERC20, Ownable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;

    constructor(address initialOwner) ERC20("Neurion", "NRN") Ownable(initialOwner) {
        _mint(initialOwner, MAX_SUPPLY);
    }
}
```

## 17.3 ComputeRewardVault.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ComputeRewardVault is Ownable {
    IERC20 public immutable token;
    mapping(bytes32 => bool) public paidRewardIds;

    event RewardPaid(bytes32 indexed rewardId, address indexed nodeOwner, uint256 amount, string jobId);

    constructor(address tokenAddress, address initialOwner) Ownable(initialOwner) {
        token = IERC20(tokenAddress);
    }

    function payReward(bytes32 rewardId, address nodeOwner, uint256 amount, string calldata jobId) external onlyOwner {
        require(!paidRewardIds[rewardId], "REWARD_ALREADY_PAID");
        require(nodeOwner != address(0), "INVALID_NODE_OWNER");
        require(amount > 0, "INVALID_AMOUNT");
        paidRewardIds[rewardId] = true;
        require(token.transfer(nodeOwner, amount), "TRANSFER_FAILED");
        emit RewardPaid(rewardId, nodeOwner, amount, jobId);
    }
}
```

## 17.4 Contract tests required

```txt
- total supply minted to owner
- reward vault pays once
- duplicate rewardId rejected
- zero address rejected
- non-owner cannot pay
- insufficient vault balance fails
```

---

# 18. Crypto Backend Integration

## 18.1 Services

```txt
TokenConfigService:
  returns chainId, token address, vault address, ABI metadata.

WalletAuthService:
  SIWE nonce, verify, wallet linking.

RewardAccountingService:
  converts verified credits to token amount.

TokenPayoutService:
  creates payout rows, submits tx, confirms tx.

ComplianceFlagService:
  blocks payout if status requires it.

CaspPartnerProvider:
  abstraction for future regulated partner integration.
```

## 18.2 Payout flow

```txt
1. Job or realtime session verified
2. Credits granted
3. RewardAccountingService calculates NRN testnet amount
4. TokenPayout row created PENDING
5. Admin or processor submits transaction
6. ComputeRewardVault pays wallet
7. txHash saved
8. confirmation watcher marks CONFIRMED
```

## 18.3 CASP provider interface

```ts
interface CaspPartnerProvider {
  createKycSession(userId: string): Promise<KycSession>;
  getKycStatus(userId: string): Promise<KycStatus>;
  createBuyOrder(userId: string, fiatAmount: number, tokenSymbol: "NRN"): Promise<CaspOrder>;
  getOrderStatus(orderId: string): Promise<CaspOrderStatus>;
}
```

Default MVP implementation:

```txt
MockCaspPartnerProvider
```

---

# 19. Compliance Software Package — Italy / EU Ready

## 19.1 Docs to generate

```txt
docs/legal/
├─ micar-token-classification.md
├─ nrn-whitepaper-draft.md
├─ nrn-risk-disclosure.md
├─ nrn-terms-of-use.md
├─ node-provider-agreement.md
├─ acceptable-use-policy.md
├─ privacy-policy.md
├─ data-processing-addendum.md
├─ kyc-aml-operating-model.md
├─ casp-partner-integration.md
└─ ai-act-operating-notes.md
```

## 19.2 Product controls to implement

```txt
- no internal exchange in MVP
- no private key custody
- wallet is non-custodial
- token payout can be disabled globally
- token payout can be blocked per user/node
- suspicious reward patterns create ComplianceRecord
- all payout actions write AuditLog
- admin compliance screen required
- terms accepted timestamp stored
```

## 19.3 UI wording rules

```txt
Allowed:
- Earn rewards for verified compute.
- Use NRN to access AI compute.
- Utility token for Neurion services.

Forbidden in UI:
- guaranteed return
- APY
- investment profit language
- price prediction
- moon/pump language
```

---

# 20. Security

## 20.1 Node security

```txt
- outbound WebSocket only
- no inbound port required
- nodeKey returned only once
- nodeKeyHash stored in DB
- rotate node key command
- worker image allowlist
- Docker sandbox for Grid jobs
- no host filesystem mount except job temp folder
- CPU/RAM/time limits
- network disabled by default for worker containers
- realtime mode only via configured provider endpoint
```

## 20.2 Backend security

```txt
- argon2 password hashing
- JWT access token
- refresh token in httpOnly secure cookie
- RBAC guards
- rate limiting
- zod/class-validator validation
- audit logs
- request id correlation
- admin actions require role
```

## 20.3 Crypto security

```txt
- never store user private keys
- reward signer private key only backend secret in MVP
- production reward signer must be multisig/secure custody
- idempotent rewardId on contract
- duplicate payout prevention
- chain confirmation watcher
- contract tests mandatory
```

## 20.4 Data privacy

```txt
- PUBLIC jobs can run on community nodes
- private jobs require verified/internal nodes
- uploaded files stored with expiry
- job input deleted after retention period
- output retention configurable
- user can delete stored outputs
- audit and accounting retained separately
```

---

# 21. Docker Compose

```yaml
services:
  postgres:
    image: postgres:16
    container_name: neurion-postgres
    environment:
      POSTGRES_USER: neurion
      POSTGRES_PASSWORD: neurion
      POSTGRES_DB: neurion
    ports:
      - "5432:5432"
    volumes:
      - neurion_postgres:/var/lib/postgresql/data

  redis:
    image: redis:7
    container_name: neurion-redis
    ports:
      - "6379:6379"

  minio:
    image: minio/minio:latest
    container_name: neurion-minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: neurion
      MINIO_ROOT_PASSWORD: neurion-secret
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - neurion_minio:/data

  hardhat:
    image: node:20
    container_name: neurion-hardhat
    working_dir: /contracts
    command: sh -c "corepack enable && pnpm install && pnpm hardhat node --hostname 0.0.0.0"
    ports:
      - "8545:8545"
    volumes:
      - ./packages/contracts:/contracts

volumes:
  neurion_postgres:
  neurion_minio:
```

---

# 22. Local Run

```bash
pnpm install
docker compose up -d postgres redis minio
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Contracts:

```bash
cd packages/contracts
pnpm install
pnpm hardhat compile
pnpm hardhat test
pnpm hardhat node
pnpm hardhat run scripts/deploy-local.ts --network localhost
```

Agent:

```bash
cd apps/node-agent
go run ./cmd/neurion-node register --api http://localhost:8091 --name "Local Test Node"
go run ./cmd/neurion-node start --config neurion-node.yaml
```

Chat test:

```bash
curl -N -X POST http://localhost:8091/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message":"Ciao Neurion, rispondi in breve","mode":"AUTO"}'
```

Job test:

```bash
curl -X POST http://localhost:8091/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"type":"echo.v1","inputJson":{"text":"hello neurion"}}'
```

---

# 23. Seed Data

```txt
Workspace:
  name: Neurion Local
  slug: neurion-local

Users:
  admin@neurion.local / ChangeMe!Neurion2026 / SUPER_ADMIN
  node@neurion.local  / ChangeMe!Node2026    / NODE_PROVIDER
  user@neurion.local  / ChangeMe!User2026    / USER

Initial credits:
  admin: 1000
  user: 100
  node provider: 0

Models:
  mock-chat-small
  local-ollama-llama3.1-8b

Feature flags:
  AI_ENABLE_FALLBACK=true
  TOKEN_PAYOUTS_ENABLED=true for local/testnet only
```

---

# 24. Web Pages

## 24.1 Public

```txt
/
- Hero
- How it works
- Fast AI Chat
- Distributed Grid
- Earn credits
- NRN utility token
- Download Node
- Open-source philosophy

/login
/register
```

## 24.2 App

```txt
/app/chat
- ChatGPT-like interface
- streaming answer
- route badge: Fast/Grid/Fallback
- cost estimate
- privacy selector
- file upload
- async job cards in conversation

/app/dashboard
- credits
- NRN testnet
- active nodes
- chat usage
- jobs today
- network status

/app/jobs
/app/jobs/[id]
/app/nodes
/app/nodes/[id]
/app/credits
/app/wallet
/app/admin
/app/admin/compliance
```

---

# 25. Admin Dashboard Metrics

```txt
- total users
- active users
- active nodes
- online realtime nodes
- online grid nodes
- average first token ms
- average tokens/sec
- jobs pending
- jobs running
- jobs completed today
- chat messages today
- fallback usage percentage
- credits issued
- credits spent
- token payouts pending
- failed jobs
- suspicious nodes
```

---

# 26. Definition of Done — MVP v1.1

MVP v1.1 is done when:

```txt
- Web app starts locally
- API starts locally
- DB migrations work
- seed works
- admin login works
- user can open /app/chat
- chat streams response using mock/fallback provider
- AI Router writes routing decision
- node can register
- Go agent connects
- heartbeat visible
- agent supports grid mode
- user can create echo job
- agent receives job
- worker executes in Docker
- result returns to API
- job becomes VERIFIED
- credits are spent and rewarded
- wallet can connect via SIWE
- local NRN token deploys
- payout is created
- admin processes payout
- tx hash is stored
- audit logs exist
- deploy scripts exist for VPS
```

---

# 27. Codex Agent Build Plan v1.1

## 27.1 General instruction

```txt
You are building Neurion v1.1.

Neurion is a production-oriented distributed AI compute platform with:
- fast ChatGPT-like AI chat
- Fast Lane / Grid Lane / Fallback Lane routing
- local node agent
- distributed worker jobs
- internal credits
- NRN utility token testnet integration

Do not create disconnected mock UI.
Do not leave fake buttons.
Do not remove working modules.
Everything must run locally with Docker Compose.
Use TypeScript strict mode.
Use RBAC and audit logs.
Implement streaming chat with SSE.
Implement crypto in local/testnet mode.
```

---

## Agent 00 — Repo Bootstrap

```txt
Create Neurion monorepo exactly as specified in NEURION_SPEC_Codex_IT_EN_v1.1.md.

Requirements:
- pnpm workspace
- turbo
- apps/api NestJS
- apps/web Next.js App Router
- apps/node-agent Go skeleton
- apps/workers/echo-worker
- packages/shared
- packages/protocol
- packages/contracts Hardhat
- docker-compose.yml
- .env.example
- README

Root scripts:
- pnpm dev
- pnpm build
- pnpm lint
- pnpm test
- pnpm db:migrate
- pnpm db:seed

Acceptance:
- pnpm install works
- docker compose up works
- pnpm build works
```

---

## Agent 01 — API, DB, Auth

```txt
Implement Neurion API core.

Use:
- NestJS
- Prisma
- PostgreSQL
- JWT access token
- refresh cookie httpOnly
- argon2
- RBAC guard
- AuditLog service

Implement Prisma schema from v1.1 spec.
Implement migrations and seed.

Endpoints:
- POST /api/auth/register
- POST /api/auth/login
- POST /api/auth/logout
- GET /api/auth/me
- POST /api/auth/refresh
- GET /api/admin/dashboard

Acceptance:
- login works
- refresh works
- admin dashboard returns metrics
- audit logs written
```

---

## Agent 02 — AI Chat + Router + SSE

```txt
Implement ChatGPT-like AI chat backend.

Create:
- ChatConversation model usage
- ChatMessage model usage
- AI Router service
- Provider interface
- MockProvider
- OpenAICompatibleProvider
- FallbackProvider logic
- SSE streaming endpoint

Endpoints:
- POST /api/chat/conversations
- GET /api/chat/conversations
- GET /api/chat/conversations/:id
- POST /api/chat/conversations/:id/messages
- GET /api/chat/conversations/:id/messages
- POST /api/chat/stream
- POST /api/chat/estimate

Requirements:
- stream token events
- write routing decision into ChatMessage
- deduct credits for chat
- use fallback when fast node unavailable
- first local version can use MockProvider but must be replaceable

Acceptance:
- /api/chat/stream streams tokens
- /app/chat can consume stream later
- routing decision is stored
- credits are charged
```

---

## Agent 03 — Node Registry + WebSocket Gateway

```txt
Implement node registry and websocket gateway.

Endpoints:
- POST /api/nodes/register
- GET /api/nodes
- GET /api/nodes/:id
- PATCH /api/nodes/:id
- POST /api/nodes/:id/disable
- POST /api/nodes/:id/enable
- GET /api/nodes/:id/heartbeats
- WS /ws/nodes

Messages:
- node.hello
- node.heartbeat
- job.accepted
- job.started
- job.completed
- job.failed
- realtime.chat.token
- realtime.chat.done
- realtime.chat.error

Acceptance:
- fake node connects
- heartbeat stored
- loadedModels stored
- realtime metrics stored
```

---

## Agent 04 — Fast Lane Realtime Pool

```txt
Implement Realtime Pool service.

Features:
- find warm node by model/privacy/performance
- send realtime.chat.request over websocket
- stream node tokens to API SSE client
- timeout and fallback
- record RealtimeSession
- update node performance metrics

Acceptance:
- when a fake realtime node exists with loaded model, chat routes to FAST
- if fake node times out, chat routes to FALLBACK
- firstTokenMs is stored
```

---

## Agent 05 — Job Queue + Grid Scheduler

```txt
Implement Grid Lane job queue and scheduler.

Use Redis + BullMQ.

Endpoints:
- POST /api/jobs
- GET /api/jobs
- GET /api/jobs/:id
- POST /api/jobs/:id/cancel
- GET /api/jobs/:id/events

Flow:
PENDING -> ASSIGNED -> ACCEPTED -> RUNNING -> COMPLETED -> VERIFIED -> REWARDED
FAILED -> RETRYING when retry allowed

Acceptance:
- user creates echo.v1 job
- online node receives job.assign
- node completes job
- job status changes correctly
```

---

## Agent 06 — Go Node Agent

```txt
Implement Go Neurion Node agent.

Commands:
- register
- start
- status
- benchmark
- warmup
- test-job
- test-chat

Features:
- YAML config
- hardware detection
- Docker detection
- NVIDIA detection
- outbound WebSocket
- heartbeat
- grid job execution
- realtime chat proxy to OpenAI-compatible local endpoint
- streaming tokens back to API

Acceptance:
- agent registers
- appears online
- executes echo-worker
- can proxy a test realtime chat using configured endpoint or mock mode
```

---

## Agent 07 — Worker Images

```txt
Create worker images:
- echo-worker
- embedding-worker

Standard:
/worker/run --input /job/input.json --output /job/output.json

Acceptance:
- docker build works
- local run works
- output.json valid
```

---

## Agent 08 — Credits + Verification

```txt
Implement verification and credit ledger.

Verification:
- echo exact/schema validation
- embedding schema validation
- realtime session sanity validation

Credits:
- append-only ledger
- spend credits on chat/job creation
- reward credits after verification

Acceptance:
- user balance decreases for chat/job
- node provider balance increases after verified compute
- no reward for failed job
```

---

## Agent 09 — Web Dashboard + Chat UI

```txt
Implement Next.js dashboard.

Pages:
- /
- /login
- /register
- /app/chat
- /app/dashboard
- /app/jobs
- /app/jobs/[id]
- /app/nodes
- /app/nodes/[id]
- /app/credits
- /app/wallet
- /app/admin
- /app/admin/compliance

Chat UI:
- ChatGPT-like
- streaming response
- route badge: FAST/GRID/FALLBACK
- credit cost display
- privacy selector
- file upload placeholder wired to API
- async job card in chat

Acceptance:
- user logs in
- chat streams answer
- dashboard shows credits/jobs/nodes
- nodes can be registered
```

---

## Agent 10 — Crypto Contracts

```txt
Implement packages/contracts.

Use:
- Hardhat
- Solidity ^0.8.24
- OpenZeppelin

Contracts:
- NRNToken.sol
- ComputeRewardVault.sol
- VestingVault.sol skeleton

Scripts:
- deploy-local.ts
- deploy-sepolia.ts
- mint-test-rewards.ts

Tests:
- total supply minted
- reward vault pays once
- duplicate rejected
- zero address rejected
- non-owner rejected

Acceptance:
- compile works
- tests pass
- local deploy prints addresses
```

---

## Agent 11 — Crypto Backend + Wallet

```txt
Integrate crypto.

Backend:
- TokenConfigService
- WalletAuthService SIWE
- TokenPayoutService
- RewardAccountingService
- confirmation watcher

Frontend:
- wallet connect
- sign message
- show wallet address
- show NRN contract
- payout history
- admin process payouts

Acceptance:
- wallet linked
- verified job/session creates payout pending
- admin submits local tx
- txHash saved
- payout confirmed
```

---

## Agent 12 — Compliance Docs + Controls

```txt
Create docs/legal package and software controls.

Docs:
- micar-token-classification.md
- nrn-whitepaper-draft.md
- nrn-risk-disclosure.md
- nrn-terms-of-use.md
- node-provider-agreement.md
- acceptable-use-policy.md
- privacy-policy.md
- data-processing-addendum.md
- kyc-aml-operating-model.md
- casp-partner-integration.md
- ai-act-operating-notes.md

Software:
- ComplianceRecord usage
- KYC status
- payout block if user/node disabled
- admin compliance screen

Acceptance:
- docs generated
- admin can block/unblock payouts
- blocked users cannot receive token payout
```

---

## Agent 13 — Deploy

```txt
Prepare VPS deployment.

Target:
- VPS IP 80.211.136.108
- path /opt/jit-factory/projects/neurion

Create:
- infra/nginx/neurion.conf
- infra/systemd/neurion-api.service
- infra/systemd/neurion-web.service
- infra/scripts/deploy.sh
- infra/scripts/backup-db.sh
- infra/scripts/healthcheck.sh

Health endpoints:
- GET /api/health
- GET /api/health/db
- GET /api/health/redis
- GET /api/health/storage
- GET /api/health/contracts
- GET /api/health/ai-router

Acceptance:
- deploy script builds web/api
- services start/restart
- healthcheck OK
```

---

## Agent 14 — End-to-End Test

```txt
Create E2E test script.

Flow:
1. start docker services
2. migrate DB
3. seed DB
4. login user
5. create chat stream
6. assert streamed tokens
7. register node
8. start fake websocket node
9. create echo job
10. complete job
11. verify credits
12. deploy local contract
13. link wallet
14. process payout
15. assert txHash

Acceptance:
- one command runs full local validation
- report printed at end
```

---

# 28. GitHub / CI

```txt
.github/workflows/ci.yml
.github/workflows/contracts.yml
.github/workflows/docker-workers.yml
.github/workflows/e2e.yml
```

CI checks:

```txt
- pnpm install
- pnpm lint
- pnpm test
- pnpm build
- prisma validate
- hardhat compile
- hardhat test
- worker docker build
- e2e local smoke test
```

---

# 29. First Prompt for Codex

Use this as the first command inside:

```txt
C:\jit-factory\projects\neurion
```

Prompt:

```txt
Read NEURION_SPEC_Codex_IT_EN_v1.1.md completely.

Build Neurion v1.1 exactly from the specification.

Start with Agent 00 Repo Bootstrap.
Create the monorepo, Docker Compose, env example, README and skeleton apps.
The product must include Fast Lane / Grid Lane / Fallback Lane architecture from the beginning.
Do not implement disconnected mock pages.
Everything must compile.
After bootstrap, provide a short implementation report with:
- files created
- commands to run
- what works
- what remains
```

---

# 30. Final Product Sentence

## IT
**Neurion è una rete open source italiana che trasforma potenza di calcolo inutilizzata in AI veloce e accessibile, usando una chat immediata, una grid distribuita e reward in crediti/token utility NRN.**

## EN
**Neurion is an Italian open-source network that turns idle compute power into fast and accessible AI, using an instant chat interface, a distributed grid and rewards in credits/NRN utility tokens.**

---

# 31. Build Priority

The build order is mandatory:

```txt
1. Monorepo
2. API/Auth/DB
3. Chat SSE with mock/fallback provider
4. Web chat UI
5. Node registry
6. Go node agent
7. Echo worker Grid Lane
8. Credits
9. NRN contracts
10. Wallet + token payout
11. Realtime Fast Lane nodes
12. Compliance docs/controls
13. VPS deploy
```

Reason:

```txt
The user must see a working ChatGPT-like app early.
Distributed compute and crypto are then attached to a living product, not to an empty dashboard.
```

---

# 32. MVP Visual Identity

```txt
Style: industrial dark
Mood: Linux infrastructure + AI network
Avoid: crypto casino aesthetic
Colors: black/graphite, electric blue accents, white/gray text
Logo direction: minimal neural/electric node symbol
```

---

# 33. Notes for Future Expansion

```txt
- mobile app wrapper
- desktop tray app for Neurion Node
- signed Windows installer
- auto-update
- enterprise verified nodes
- on-prem private Neurion Grid
- developer API
- Python SDK
- marketplace of worker images
- governance portal
- public network status page
```

