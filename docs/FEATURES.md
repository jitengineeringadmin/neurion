# Neurion — Complete Feature & Function Inventory

Neurion is a distributed AI compute network spanning five surfaces: a NestJS API (REST + WebSocket fleet + SSE streaming), a Next.js web app, an Electron desktop wrapper with embedded Postgres and a bundled Go node-agent, the Go node-agent itself plus TypeScript grid workers, and a Solidity smart-contract suite for the NRN token economy. The system implements a 3-lane AI router (FAST realtime / GRID jobs / FALLBACK internal), privacy-aware confidential routing (VERIFIED_ONLY floor + classifier escalation + trust-gated node selection), a three-layer compute-verification + reputation system with optimistic grants and clawback, sybil controls (stake bond, per-owner/subnet/fingerprint caps), an emission-capped on-chain reward/payout pipeline gated behind KYC/compliance, and full production deploy automation (VPS + systemd + nginx + CI/release). The catalog below is exhaustive and de-duplicated across all 8 evidence maps.

**Feature count by area:**

| Area | Features |
|---|---|
| 1. REST API Endpoints | 116 |
| 2. API Realtime Surface (WS / SSE / Redis) | 24 |
| 3. AI Routing System | 25 |
| 4. Verification & Trust System | 29 |
| 5. Crypto / NRN System | 27 |
| 6. Web App | 30 |
| 7. Desktop Application (Electron) | 26 |
| 8. Node-Agent, Workers & Infrastructure | 28 |
| **Total (pre-dedup, across maps)** | **~265** |

Status legend: 🟢 live · 🟡 partial · ⚪ stub · 🔴 disabled

---

## 1. REST API Endpoints (`apps/api/src`)

20 controller modules, 116 route decorators. JWT-guarded by default (`@Public` exempts); role-gated where noted (SUPER_ADMIN / ADMIN / COMPLIANCE).

### Auth (`auth/auth.controller.ts`)
- **POST /auth/register** — Public registration; creates account, issues session + refresh token; rate-limited 5/min; audit-logged. 🟢 `auth.controller.ts:65-84`
- **POST /auth/login** — Public login; access token + httpOnly refresh cookie; rate-limited 8/min; audited. 🟢 `auth.controller.ts:88-106`
- **POST /auth/refresh** — Public token refresh; rotates refresh token from cookie; detects reuse. 🟢 `auth.controller.ts:109-135`
- **POST /auth/logout** — Public logout; clears + revokes refresh cookie; always ok. 🟢 `auth.controller.ts:138-144`
- **POST /auth/forgot-password** — Public reset request; emails reset token; no account enumeration; 4/min. 🟢 `auth.controller.ts:147-152`
- **POST /auth/reset-password** — Public reset with token; updates password; 6/min. 🟢 `auth.controller.ts:155-161`
- **POST /auth/verify-email** — Public email verification via token; marks verified; 10/min. 🟢 `auth.controller.ts:164-170`
- **POST /auth/resend-verification** — Authed resend of verification email. 🟢 `auth.controller.ts:172-176`
- **POST /auth/change-password** — Authed password change (old + new). 🟢 `auth.controller.ts:178-182`
- **DELETE /auth/account** — Authed account deletion with password confirmation; clears refresh cookie. 🟢 `auth.controller.ts:184-189`
- **PATCH /auth/profile** — Authed profile update (displayName, avatar, etc). 🟢 `auth.controller.ts:191-194`
- **GET /auth/me** — Authed profile fetch (user + workspace + roles). 🟢 `auth.controller.ts:196-199`

### Admin (`admin/admin.controller.ts`)
- **GET /admin/dashboard** — Dashboard metrics (nodes, jobs, users, trust, health). Role: SUPER_ADMIN/ADMIN. 🟢 `admin.controller.ts:17-20`
- **PATCH /admin/nodes/:id/trust-level** — Set node trust level (COMMUNITY/VERIFIED/ENTERPRISE/INTERNAL). Role: SUPER_ADMIN/ADMIN. 🟢 `admin.controller.ts:22-25`

### Nodes (`nodes/nodes.controller.ts`)
- **POST /nodes/register** — Authed node registration (name + supportedJobTypes); captures registering IP. 🟢 `nodes.controller.ts:21-24`
- **GET /nodes** — List user's nodes. 🟢 `nodes.controller.ts:26-29`
- **GET /nodes/:id** — Single node + stats; ownership-checked. 🟢 `nodes.controller.ts:31-34`
- **GET /nodes/:id/heartbeats** — Heartbeat history (liveness + uptime). 🟢 `nodes.controller.ts:36-39`
- **POST /nodes/:id/disable** — Disable node (stops taking jobs); ownership-checked. 🟢 `nodes.controller.ts:41-44`
- **POST /nodes/:id/enable** — Enable node (resumes jobs); ownership-checked. 🟢 `nodes.controller.ts:46-49`

### Jobs (`jobs/jobs.controller.ts`)
- **POST /jobs** — Create job (type + inputJson + privacyLevel). 🟢 `jobs.controller.ts:23-26`
- **GET /jobs** — List user's jobs with status. 🟢 `jobs.controller.ts:28-31`
- **GET /jobs/:id** — Single job + metadata; ownership + privacy checked. 🟢 `jobs.controller.ts:33-36`
- **GET /jobs/:id/events** — Job execution events / progress timeline. 🟢 `jobs.controller.ts:38-41`
- **POST /jobs/:id/cancel** — Cancel job if not complete; ownership-checked. 🟢 `jobs.controller.ts:43-46`

### Chat (`chat/chat.controller.ts`)
- **POST /chat/conversations** — Create conversation (title + privacyLevel). 🟢 `chat.controller.ts:36-39`
- **GET /chat/conversations** — List conversations with metadata. 🟢 `chat.controller.ts:41-44`
- **GET /chat/conversations/:id** — Conversation details; privacy-checked. 🟢 `chat.controller.ts:46-49`
- **GET /chat/conversations/:id/messages** — List messages (chat history). 🟢 `chat.controller.ts:51-54`
- **PATCH /chat/conversations/:id** — Update conversation (title, pinned, projectId). 🟢 `chat.controller.ts:56-59`
- **DELETE /chat/conversations/:id** — Delete conversation + messages. 🟢 `chat.controller.ts:61-64`
- **POST /chat/estimate** — Pre-flight cost estimate (routing plan + token estimate); no credit spend. 🟢 `chat.controller.ts:66-83`
- **POST /chat/stream** — SSE chat reply; routes to realtime node or mock fallback; streams tokens + final cost; deducts credits. 🟢 `chat.controller.ts:85-254`

### Credits (`credits/credits.controller.ts`)
- **GET /credits/balance** — Current credit balance. 🟢 `credits.controller.ts:9-12`
- **GET /credits/ledger** — Transaction history (`?take=N`, default 50 / max 200). 🟢 `credits.controller.ts:14-18`

### Crypto — Wallet (`crypto/wallet.controller.ts`)
- **POST /wallet/nonce** — Public; challenge nonce for wallet sign-in. 🟢 `wallet.controller.ts:25-28`
- **POST /wallet/verify** — Verify signature (address + nonce + sig); links wallet. 🟢 `wallet.controller.ts:30-33`
- **POST /wallet/disconnect** — Unlink wallet. 🟢 `wallet.controller.ts:35-38`
- **GET /wallet/me** — Linked wallet addresses. 🟢 `wallet.controller.ts:40-43`

### Crypto — Token (`crypto/token.controller.ts`)
- **GET /token/config** — Public; token price, conversion rates, payout thresholds. 🟢 `token.controller.ts:23-26`
- **GET /token/payouts** — List user's payout requests. 🟢 `token.controller.ts:28-31`
- **POST /token/request-payout** — Request payout (credits ≥ 1); queued. 🟢 `token.controller.ts:33-36`
- **GET /token/payouts/:id** — Payout details; ownership-checked. 🟢 `token.controller.ts:38-41`
- **POST /token/admin/process-payouts** — Batch-process pending payouts. Role: SUPER_ADMIN/ADMIN. 🟢 `token.controller.ts:43-47`

### Compliance (`compliance/compliance.controller.ts`)
- **GET /admin/compliance** — List compliance records. Role: SUPER_ADMIN/ADMIN/COMPLIANCE. 🟢 `compliance.controller.ts:18-21`
- **POST /admin/compliance/:userId/block-payouts** — Block user payouts (reason logged). 🟢 `compliance.controller.ts:23-26`
- **POST /admin/compliance/:userId/unblock-payouts** — Clear payout restriction. 🟢 `compliance.controller.ts:28-31`

### Agent (`agent/agent.controller.ts`)
- **POST /agent/stream** — SSE multi-turn agent run (goal + model/cwd); streams agent.* events. 🟢 `agent.controller.ts:37-57`
- **POST /agent/approve** — Approve/deny pending agent tool action. 🟢 `agent.controller.ts:59-62`

### Projects (`projects/projects.controller.ts`)
- **POST /projects** — Create project (name + path) for chat context. 🟢 `projects.controller.ts:72-75`
- **GET /projects** — List projects with metadata. 🟢 `projects.controller.ts:77-80`
- **POST /projects/pick-folder** — Windows-only native folder picker. 🟡 `projects.controller.ts:82-85`
- **DELETE /projects/:id** — Delete project; orphans conversations. 🟢 `projects.controller.ts:87-90`

### Forum (`forum/forum.controller.ts`)
- **GET /forum/sections** — Public; list discussion categories. 🟢 `forum.controller.ts:13-16`
- **GET /forum/latest** — Public; latest posts. 🟢 `forum.controller.ts:18-22`
- **GET /forum/threads** — Public; threads by section (`?section=`). 🟢 `forum.controller.ts:24-28`
- **GET /forum/threads/:id** — Public; thread + all posts. 🟢 `forum.controller.ts:30-34`
- **POST /forum/threads** — Create thread (title + body); 6/min. 🟢 `forum.controller.ts:36-40`
- **POST /forum/threads/:id/posts** — Reply to thread; 20/min. 🟢 `forum.controller.ts:42-46`
- **DELETE /forum/posts/:id** — Delete post; author/moderator only. 🟢 `forum.controller.ts:48-51`
- **DELETE /forum/threads/:id** — Delete thread; author/moderator only. 🟢 `forum.controller.ts:53-56`
- **PATCH /forum/threads/:id** — Moderate (lock/pin/highlight); admin/moderator only. 🟢 `forum.controller.ts:58-61`

### Network (`network/network.controller.ts`)
- **GET /network/stats** — Public; aggregate stats; cached 5s; no per-node privacy data. 🟢 `network.controller.ts:12-16`
- **GET /network/history** — Public; stats history; cached 30s. 🟢 `network.controller.ts:18-22`

### App Config (`app-config/app-config.controller.ts`)
- **GET /config** — Public; `restricted` flag (true=online no-local-AI, false=desktop full). 🟢 `app-config.controller.ts:12-15`

### Health (`health/health.controller.ts`)
- **GET /health** — Public; status + service + version. 🟢 `health.controller.ts:19-22`
- **GET /health/db** — Public; DB connectivity. 🟢 `health.controller.ts:24-32`
- **GET /health/redis** — Public; Redis connectivity. 🟢 `health.controller.ts:34-48`
- **GET /health/storage** — Public; S3/MinIO check. 🟢 `health.controller.ts:50-59`
- **GET /health/contracts** — Public; blockchain RPC check + chainId. 🟢 `health.controller.ts:61-78`
- **GET /health/ai-router** — Public; AI engine check (ok/fallback_only + provider). 🟢 `health.controller.ts:80-90`

### AI Models (`ai/models.controller.ts`)
- **GET /ai/models** — Available models + chatDefault/agentDefault. Public. 🟢 `models.controller.ts:56-63`
- **GET /ai/models/recommended** — Public; curated model list grouped by family. 🟢 `models.controller.ts:65-68`
- **GET /ai/models/installed** — Public; locally-downloaded models + engine status. 🟢 `models.controller.ts:71-82`
- **POST /ai/models/pull** — SSE model download; proxies ollama `/api/pull` with progress. 🟢 `models.controller.ts:85-139`

---

## 2. API Realtime Surface — WebSocket / SSE / Redis (`apps/api/src`)

### Node fleet WebSocket
- **Node WS Gateway** — Raw WS server at `/ws/nodes`; handles node.hello (auth + capabilities), node.heartbeat (metrics), routes job.*/realtime.* from online nodes; maintains nodeId→socket map. 🟢 `nodes/node-gateway.service.ts:15-245`
- **WS Node Authentication** — node.hello requires nodeId + nodeKey; verifies SHA256(nodeKey)==nodeKeyHash; rejects + closes on mismatch; sets node ONLINE on success. 🟢 `node-gateway.service.ts:168-212`
- **Node Presence & Fleet Routing** — Redis PRESENCE_CH broadcasts online/offline across instances; ROUTE_CH cross-instance messaging; ALIVE_PREFIX TTL=35s; reconciliation polls every 15s. 🟢 `node-gateway.service.ts:54-102`
- **Node Message Routing (ROUTE_CH)** — `gateway.send()` tries local socket, else publishes to ROUTE_CH for cluster-wide delivery. 🟢 `node-gateway.service.ts:112-124`
- **Node Events (job.* / realtime.*)** — Emits job.accepted/started/completed/failed, realtime.chat.token/done/error, node.online; each tagged with nodeId. 🟢 `node-gateway.service.ts:148-165`
- **Node Heartbeat Metrics Storage** — Persists NodeHeartbeat (cpuLoad, ramUsedMb, gpuLoad/tempC, freeDiskMb, tokens/sec, activeRealtimeSessions); refreshes capabilities on node.hello. 🟢 `node-gateway.service.ts:214-230, 187-207`
- **Redis Multi-Instance Mode** — RedisService (kv/pub/sub clients) enables horizontal scaling when REDIS_URL set; single-process fallback for desktop. 🟢 `common/redis.service.ts:12-49`

### Chat SSE
- **Chat SSE Streaming Endpoint** — Emits routing / token / final / error events; backpressure via writableNeedDrain; pre-token fallback to mock. 🟢 `chat/chat.controller.ts:85-254`
- **Token Streaming & Backpressure** — Yields provider tokens; flush() awaits drain; captures firstTokenMs; persists full response after stream. 🟢 `chat.controller.ts:92-199`
- **Chat Fallback & Failover** — On FAST-lane node failure pre-first-token, switches to labeled MockProvider (FALLBACK/INTERNAL); NO_ONLINE_ENGINE returns free notice; reward only if actually served. 🟢 `chat.controller.ts:181-210, 121-147`
- **Chat Cost Reconciliation** — After stream, recomputes actual cost from getUsage() tokens; spends/refunds delta best-effort. 🟢 `chat.controller.ts:213-226`
- **Node Reward System** — Rewards node owner NRN only when realtime node served (FAST + servedByNode); idempotent via assistant-message ref; output-char metered, capped. 🟢 `chat.controller.ts:228-235`, `ai/realtime-pool.service.ts:64-77`
- **Estimate Endpoint (No Streaming)** — POST /chat/estimate returns RoutePlan + balance without consuming credits. 🟢 `chat.controller.ts:66-83`
- **Chat Conversation Context** — buildContext() loads last 40 user+assistant messages + system prompt; multi-turn history. 🟢 `chat/chat.service.ts:85-151`
- **Chat Message Routing Record** — Persists ChatMessageRoute (effective/requested privacy, routeReason, lane, servedTrustLevel, responseTrusted, escalated, classifierCategory, firstTokenMs). 🟢 `chat.service.ts:98-152`

### Agent SSE
- **Agent SSE Streaming Endpoint** — Emits agent.start / tool_call / tool_result / approval_request / approval_result / subagent.start / subagent.end / final / done / error; up to 6 steps; sub-agents depth<2. 🟢 `agent/agent.controller.ts:37-56`, `agent/agent-orchestrator.service.ts:128-188`
- **Agent Orchestrator Loop** — Iterates MAX_STEPS=6 (SUB_MAX_STEPS=4); LLM call with system prompt + tools; tool execution + observation; DANGEROUS tools gated by AGENT_REQUIRE_APPROVAL. 🟢 `agent-orchestrator.service.ts:128-188`
- **Agent Approval System** — AgentApprovalService.wait(id) registers async waiter; emits agent.approval_request for DANGEROUS tools; resolves on approve/deny. 🟢 `agent-orchestrator.service.ts:153-168`

### Routing / realtime providers (cross-listed with §3)
- **Chat Routing & Lane Selection** — AiRouterService.plan() resolves privacy, estimates heaviness, tries warm node (FAST), else FALLBACK. 🟢 `ai/ai-router.service.ts:69-119`
- **Realtime Node Provider (FAST Lane)** — Sends realtime.chat.request via gateway; bridges node token/done/error into async stream; 60s timeout. 🟢 `ai/realtime-node.provider.ts:1-89`
- **Realtime Pool & Node Selection** — findWarm() filters online nodes by realtime mode + loaded model + trust level; orders by reputation DESC, avgFirstTokenMs ASC. 🟢 `ai/realtime-pool.service.ts:34-77`
- **Privacy Classification & Escalation** — classify() flags sensitive data; resolveEffectivePrivacy() escalates up only (CLASSIFIER_FAILSAFE / SERVER_HARD_BLOCK). 🟢 `ai/ai-router.service.ts:50-67`

### Jobs lifecycle (cross-listed with §4)
- **Job Lifecycle & Gateway Events** — JobsService creates PENDING with upfront spend; scheduler assigns on node.online; PENDING→ASSIGNED→ACCEPTED→RUNNING→COMPLETED, each logged as jobEvent. 🟢 `jobs/job-scheduler.service.ts:24-122`

---

## 3. AI Routing System (`apps/api/src/ai`)

- **AiRouterService (3-lane router)** — Core G2+G8 router; resolves privacy, estimates heaviness, picks lane; returns full RoutePlan. 🟢 `ai-router.service.ts:40-130`
- **FAST lane (realtime node selection)** — Non-heavy → warm trusted node (online, VERIFIED_ONLY+, model loaded, reputation-sorted) + node reward. 🟢 `ai-router.service.ts:81-99`
- **GRID lane** — Heavy jobs (tokens>6000 or attachments>5MB) routed to persistent grid jobs; lane set in jobs.service but no direct router logic yet. ⚪ `ai/estimator.service.ts:12-37`, `jobs/jobs.service.ts:37`
- **FALLBACK lane (internal/trusted provider)** — ollama / ds4 / labeled mock; used when no warm node, privacy too strict, or GRID completion; responseTrusted:true. 🟢 `ai-router.service.ts:102-118`
- **RealtimePoolService (warm node pool)** — Filters by online + supportedModes:'realtime' + loadedModels + trustLevel; sorted by reputation + avgFirstTokenMs. 🟢 `realtime-pool.service.ts:34-57`
- **RealtimeNodeProvider (WS streaming)** — Bound to a warm node; bridges node realtime.chat.* into async token stream; 60s timeout, request-id correlation. 🟢 `realtime-node.provider.ts:10-88`
- **ProviderResolverService (G3)** — Resolution order: forced override → test=mock → ds4 if reachable → ollama if reachable → loud labeled mock; merges model lists. 🟢 `provider-resolver.service.ts:18-93`
- **OpenAICompatibleProvider** — Streams from any OpenAI-compatible `/chat/completions`; captures usage for reconciliation; used for ollama + ds4. 🟢 `providers/openai-compatible.provider.ts:8-72`
- **MockProvider (test-only, labeled)** — Always emits visible `⚠️ [MOCK PROVIDER]` banner; used in test or AI_PROVIDER_DEFAULT=mock. 🟢 `providers/mock.provider.ts:7-24`
- **AiProvider interface** — Contract: name, labeled, streamChat(), optional getUsage(). 🟢 `providers/ai-provider.interface.ts:12-21`
- **PrivacyClassifierService (G2)** — Fail-safe-up regex classifier (SECRET / ART9 / PII); raises floor only; hard-blocks on SECRET/ART9; 16k cap, ReDoS-protected. 🟢 `privacy/classifier.service.ts:23-75`
- **Privacy levels enum** — PUBLIC→EU_ONLY→VERIFIED_ONLY→ENTERPRISE_ONLY→INTERNAL_ONLY; chat floor VERIFIED_ONLY. 🟢 `privacy/privacy.util.ts:3-14`
- **Trust gating (allowedTrustLevels)** — COMMUNITY allowed only when eff===PUBLIC; higher tiers progressively restrict. 🟢 `privacy/privacy.util.ts:20-36`
- **EffectivePrivacy resolution** — max(conversationPrivacy, floor) + classifier escalation; never downgrades. 🟢 `ai-router.service.ts:50-67`
- **EstimatorService (G8 heaviness)** — chars/4 token heuristic + byte threshold; returns isHeavy, estCredits, estSeconds, reasons. 🟢 `estimator.service.ts:14-38`
- **Model registry (RECOMMENDED)** — 40+ curated models (Qwen 2.5 / Coder / 3 / QwQ, Llama 3.2, Gemma 2, Phi 3.5) grouped with size/notes. 🟢 `models.controller.ts:11-41`
- **Models endpoints** — listModels / recommended / installed / SSE pull (proxies ollama tags + pull). 🟢 `models.controller.ts:56-140`
- **RouteReason enum** — USER_SELECTED, CLASSIFIER_ESCALATED, SERVER_HARD_BLOCK, CLASSIFIER_FAILSAFE, NO_WARM_TRUSTED_NODE. 🟢 `ai-router.service.ts:3,19`
- **Reward mechanism (rewardRealtimeServe)** — outputChars/4 tokens × rate, capped; idempotent via message ref; fee via rewardWithFee(). 🟢 `ai-router.service.ts:126-129`, `realtime-pool.service.ts:64-77`
- **Node trust levels enum** — COMMUNITY / VERIFIED / ENTERPRISE / INTERNAL. 🟢 `realtime-pool.service.ts:14`
- **ds4/DwarfStar support** — Optional DeepSeek-V4 via OpenAI-compatible API; preferred over ollama if reachable; badge 'ds4'. 🟢 `provider-resolver.service.ts:28-34, 79-83`
- **Reachability check** — Pings `/models` with 800ms timeout to choose provider / fall back to mock. 🟢 `provider-resolver.service.ts:40-50`
- **RouteInput interface** — message, conversationPrivacy, consent flag, attachmentBytes, preferredModel. 🟢 `ai-router.service.ts:26-33`
- **RoutePlan output** — lane, provider, model, nodeId, effective/requested privacy, routeReason, servedTrustLevel, classification, estimate, responseTrusted. 🟢 `ai-router.service.ts:11-24`

---

## 4. Verification & Trust System (G1 / G5 / G12)

- **L1 Sanity Verification** — Deterministic shape/plausibility (echo exact match; embedding dim/finite/non-zero); fail→FAILED + refund, runs before L2. 🟢 `jobs/verification.service.ts:48-65`
- **L2 Deep Re-Execution (sampling)** — Re-exec on TRUSTED reference executor only; embedding cosine≥0.9995 + norm-ratio 0.97–1.03; fail→SUSPEND + clawback + retro-audit. 🟢 `verification.service.ts:78-93, 246-252, 234-244`
- **Sampling Decision (reputation-weighted)** — SAMPLE_BASE=0.15, FLOOR=0.03, HIGH_VALUE_THRESHOLD=25 forces 100%; probation/suspended always sampled; VERIFY_FORCE_SAMPLE override. 🟢 `verification.service.ts:67-76`, `verification/helpers.ts:5-10`
- **Reputation EWMA** — Per-node (default 0.5); moves only on deep-verified outcomes; α=0.1; gates sampling, premium access, NRN eligibility. 🟢 `verification/helpers.ts:41-44`, `verification.service.ts:255`
- **Node Lifecycle (PROBATION→ACTIVE→SUSPENDED)** — Starts PROBATION (100% verified), graduates after 30 deep-PASSes (stake refunded); deep-FAIL→SUSPENDED + stake forfeited (rep→0). 🟢 `verification.service.ts:256, 267-274, 143-148`
- **Optimistic Grant + Clawback** — Unsampled jobs granted at COMPLETED (outstandingOptimisticCredits tracked); deep-FAIL claws back up to min(balance, outstanding); NRN withheld until verified. 🟢 `verification.service.ts:112-121, 133-162`
- **Retro-Audit** — On deep-FAIL, re-execs RETRO_AUDIT_WINDOW=50 recent unsampled REWARDED jobs; each mismatch clawed back + refunded. 🟢 `verification.service.ts:166-198`
- **Owner Reputation Keystone** — One node's deep-FAIL decrements owner.effectiveReputation by 0.3 + increments deepFailCount, raising all sibling sample rates. 🟢 `verification.service.ts:151-153`
- **Node Registration + Sybil Cap** — NODE_MAX_PER_OWNER=20; atomic claim on OwnerReputation.nodeCount; NODE_STAKE_CREDITS bond debited at register. 🟢 `nodes/nodes.service.ts:18-67`
- **Sybil Detection: IP/Subnet** — Stores registrationIp + subnet24Hash; maxNodesPerSubnet24=3. 🟢 `nodes.service.ts:56-57`
- **Sybil Detection: Hardware Fingerprint** — Stores node.hardwareFingerprint; maxNodesPerFingerprint=2. 🟢 `schema.prisma:208, 841`
- **Trust Levels (COMMUNITY/VERIFIED/ENTERPRISE/INTERNAL)** — Classification; admin setNodeTrustLevel promotes; affects privacy routing. 🟢 `admin/admin.service.ts:9-11`
- **Trusted Executor Service** — Reference outputs: echo.v1 in-process; embedding.v1 via @xenova/transformers MiniLM-L6-v2 (optional); returns null→provisional + NRN withheld. 🟢 `verification/trusted-executor.service.ts:15-53`
- **K-Replica Consensus (multi-worker)** — Clusters K replicas (echo exact / embedding cosine≥0.9995); majority + outlier slashing; no majority → escalate to L3. ⚪ `verification/helpers.ts:46-89`
- **Emission Schedule & Cap (G12)** — Per-epoch budget (1M NRN/day) + lifetime pool cap (400M); optimistic CAS prevents over-emit; 6× retry. 🟢 `crypto/emission.service.ts:5-80`
- **Job Verification Record** — JobVerification (jobId idempotency, type, sanityPassed, sampled, method, outcome, score, provisional, detail JSON, resolvedAt). 🟢 `schema.prisma:369-390`
- **NRN Payout Eligibility (strict gate)** — Job.nrnPayoutEligible only after deep-VERIFIED pass; gates on-chain emission; blocks pass-by-trust laundering. 🟢 `verification.service.ts:230, 275`
- **Cosine Similarity Verification** — cosine≥0.9995 AND normRatio∈[0.97,1.03]; norm ratio detects scaled fakes; tolerant of float heterogeneity. 🟢 `verification/helpers.ts:92-98`
- **Job Reward Constants** — echo.v1→1, embedding.v1→3 credits; ENABLED_TYPES gate MVP (echo + embedding). 🟢 `verification.service.ts:17-20`, `jobs/jobs.service.ts:8-12`
- **Probation Graduation Stake Refund** — On graduation, stakeRefunded flag flipped + stake refunded; pre-graduation fraud forfeits bond. 🟢 `verification.service.ts:270-274`
- **Slashing (suspend + rep-drop + clawback + refund)** — slash() atomically suspends, zeros rep, claws back outstanding, refunds user, logs jobEvent; triggers async retro-audit. 🟢 `verification.service.ts:131-162`
- **Protocol Fee (take-rate)** — gross×(bps/10_000) via rewardWithFee()/collectFee(); treasury account receives share; PROTOCOL_FEE_BPS default 0. 🟢 `credits/credits.service.ts:31-55`, `verification/helpers.ts:13-16`
- **Network Stats: Health Metrics** — verificationPassRate (sampled PASS/(PASS+FAIL)); tracks optimisticJobs + verifiedJobs. 🟢 `network/network.service.ts:196-199, 259-265`
- **Provisional Verification (degraded fallback)** — Executor unavailable → provisional, score=0.5, nrnPayoutEligible=false, reward optimistic but NRN withheld. 🟢 `verification.service.ts:236-243`
- **Registration Challenge & PoW** — RegistrationChallenge (STAKE | POW, powDifficulty bits); lifecycle PENDING→SOLVED→CONSUMED/REFUNDED/FORFEITED/EXPIRED; velocity cap. 🟡 `schema.prisma:797-830`
- **Job Scheduler: Node Selection by Reputation** — tryAssign() picks highest-rep online node matching supportedJobTypes; atomic claim; avoids DISABLED/BANNED. 🟢 `jobs/job-scheduler.service.ts:32-76`
- **Lifecycle State Transitions (admin/compliance)** — Admin setNodeTrustLevel; auto PROBATION→ACTIVE/SUSPENDED; suspended always sampled if re-enabled. 🟢 `admin/admin.service.ts:9-11`

---

## 5. Crypto / NRN System

### Smart contracts (`packages/contracts`)
- **NRNToken (ERC20)** — Standard ERC20, 1B supply ceiling, owner-minted at deploy. 🟢 `contracts/NRNToken.sol:1-13`
- **ComputeRewardVault** — On-chain NRN vault; owner-only payReward() to operators; idempotent per rewardId. 🟢 `contracts/ComputeRewardVault.sol:1-27`
- **ComputeNodeStakingBond** — Operator bond: stake / requestUnstake (cooldown) / withdraw / slash; forfeited bond → treasury. 🟢 `contracts/ComputeNodeStakingBond.sol:1-98`
- **DisputeResolver** — Bonded dispute market; openDispute() + arbiter resolve (uphold/reject); slash split challenger + treasury. 🟢 `contracts/DisputeResolver.sol:1-105`
- **VestingVault** — Linear vesting with cliff for single beneficiary (team/advisors). 🟢 `contracts/VestingVault.sol:1-56`
- **ComputeRewardVault Idempotency** — payReward() keyed by keccak256(payout.id); paidRewardIds prevents double-pay; failure refunds credits. 🟢 `token-payout.service.ts:102-122`

### Backend crypto services (`apps/api/src/crypto`)
- **TokenConfigService** — Env config: chainId, token + vault addresses, CREDIT_TO_NRN_WEI, TOKEN_PAYOUTS_ENABLED, RPC_URL, signer key; publicConfig() hides RPC. 🟢 `token-config.service.ts:1-57`
- **Token-to-Credit Conversion** — CREDIT_TO_NRN_WEI (default 0.1 NRN/credit); creditsToWei / weiToCredits helpers. 🟢 `token-payout.service.ts:22-27`
- **Wallet Auth (SIWE)** — createNonce() + verify() via ethers.verifyMessage(); nonce 10min expiry; one wallet per user; disconnect(). 🟢 `wallet-auth.service.ts:1-70`
- **WalletController (REST)** — nonce/verify/disconnect/me (see §1). 🟢 `wallet.controller.ts:1-44`
- **Credit Ledger** — Append-only log (spend/grant/reward/clawback/fee); denormalized balance via atomic txns. 🟢 `credits/credits.service.ts:57-122`, `schema.prisma:685-700`
- **Token Payout Service** — requestPayout() (spend + fee + record) + processPayouts() (admin batch on-chain via vault; emission reserve + failure refund). 🟢 `token-payout.service.ts:1-128`
- **Payout KYC/Compliance Gates** — Requires linked wallet, payoutHold=false, kycStatus not blocked/rejected; ≥1000 credits requires KYC_APPROVED. 🟢 `token-payout.service.ts:29-41`
- **Payout Protocol Fee** — PROTOCOL_FEE_BPS on request-payout → treasury; separate PROTOCOL_REWARD_FEE_BPS on rewards. 🟢 `credits.service.ts:42-55`, `token-payout.service.ts:46`
- **Emission Cap (G12)** — Per-epoch budget + lifetime pool cap via CAS; default 1M/day, 400M lifetime; defers over-cap payouts. 🟢 `emission.service.ts:1-100`
- **Node Reward + Clawback** — grant() credits owner minus reward fee; optimistic flag; slash() claws back unspent on fraud. 🟢 `jobs/verification.service.ts:112-150`
- **TokenController (REST)** — config/payouts/request-payout/payouts:id/admin-process (see §1). 🟢 `token.controller.ts:1-48`
- **TOKEN_PAYOUTS_ENABLED flag** — Default false; gates all on-chain emission (request + process throw Forbidden when off). 🟢 `token-config.service.ts:22-24`, `token-payout.service.ts:31,81`
- **Chain Configuration** — CHAIN_ID (default 31337 hardhat), RPC_URL, contract addresses; exposed in publicConfig. 🟢 `token-config.service.ts:10-37`
- **Audit Logging** — Payout request/confirm + compliance holds logged to AuditLog. 🟢 `token-payout.service.ts:58-64, 108-114`, `compliance.service.ts:21-27`
- **Reward Signer (key custody)** — REWARD_SIGNER_PRIVATE_KEY → ethers.Wallet for payReward(); backend-only. 🟢 `token-config.service.ts:45-50`
- **Compliance Hold (User.payoutHold)** — Admin blockPayouts()/unblockPayouts(); blocked request → 403. 🟢 `compliance/compliance.service.ts:16-43`

### Crypto DB models (`apps/api/prisma/schema.prisma`)
- **TokenPayout model** — PENDING→PROCESSING→SUBMITTED→CONFIRMED (+ FAILED/CANCELLED/BLOCKED); indexed userId+status. 🟢 `schema.prisma:702-729`
- **WalletNonce model** — address, nonce, used, expiresAt (10min); anti-replay. 🟢 `schema.prisma:731-740`
- **EmissionSchedule model** — epochKey, epochBudgetWei, emittedThisEpoch/LifetimeWei, poolCapWei; CAS reserve. 🟢 `schema.prisma:934-945`
- **KYC Status enum** — KYC_NOT_REQUIRED→REQUIRED→PENDING→APPROVED/REJECTED + PAYOUT_BLOCKED. 🟢 `schema.prisma:153-160`

---

## 6. Web App (`apps/web`)

### Auth pages
- **Home (Landing)** — Public landing with branding, CTA, Matrix rain bg, theme/lang toggles. 🟢 `app/page.tsx:1-44`
- **Login/Register** — Unified tabbed auth; demo-credential autofill (NEXT_PUBLIC_DEMO_LOGIN); validation + errors. 🟢 `app/login/page.tsx:1-97`
- **Forgot Password** — Email reset flow; no email-existence reveal. 🟢 `app/forgot/page.tsx:1-58`
- **Password Reset** — Token-based reset; pw≥10 chars, confirm match. 🟢 `app/reset/page.tsx:1-72`
- **Email Verification** — Token verification landing; success/failure state. 🟢 `app/verify/page.tsx:1-46`

### App routes
- **Chat (Conversation UI)** — Plain/agent mode; trace, approval prompts, cost/routing badges, model dropdown, balance, analyze-folder; URL `?c=id` persistence; streamChat/streamAgent. 🟢 `app/app/chat/page.tsx:1-231`
- **Agent Runner** — Freeform goal; step-by-step trace (tool calls/results/sub-agents); approval prompts; plan progress. 🟢 `app/app/agent/page.tsx:1-149`
- **Models (AI Engine Mgmt)** — Engine status, installed models, recommended w/ download progress, node-agent UI (start/stop/register), make-default. 🟢 `app/app/models/page.tsx:1-210`
- **Dashboard (Network Overview)** — Credits, jobs, rewarded jobs, nodes, online nodes; aggregated. 🟢 `app/app/dashboard/page.tsx:1-43`
- **Jobs** — Create echo.v1 jobs; 2s polling list with status + cost/reward, color-coded. 🟢 `app/app/jobs/page.tsx:1-78`
- **Nodes** — Register node; shows nodeId/nodeKey once; 3s polling list (status, trust, lifecycle, job count). 🟢 `app/app/nodes/page.tsx:1-68`
- **Wallet** — MetaMask connect (eth_requestAccounts, personal_sign); token config; linked wallet; payout form + history w/ tx hash. 🟢 `app/app/wallet/page.tsx:1-118`
- **Account (Profile & Security)** — Profile edit (name/avatar preview), email-verify status + resend, change password, account deletion danger zone. 🟢 `app/app/account/page.tsx:1-155`
- **Forum (Public Board)** — Read-only board; theme/lang; participate button → /app/forum or /login. 🟢 `app/forum/page.tsx:1-25`
- **Forum (App Board)** — Logged-in board, canPost=true. 🟢 `app/app/forum/page.tsx:1-5`
- **Forum Thread (Public)** — Read-only thread; no reply. 🟡 `app/forum/[id]/page.tsx:1-24`
- **Forum Thread (App)** — Logged-in thread with reply. 🟡 `app/app/forum/[id]/page.tsx:1-5`
- **Network Stats (Public)** — Real-time dashboard (10s poll): node/job/payout counts, composition by status/trust/OS/region, capabilities, health, economy, performance, history sparklines; donut/bar/progress/sparkline charts. 🟢 `app/network/page.tsx:1-253`
- **Admin Dashboard** — Role-checked; fetches /admin/dashboard, dumps raw JSON in code block. ⚪ `app/app/admin/page.tsx:1-24`

### Cross-cutting
- **App Layout (Main Container)** — Top nav + segmented tabs + sessions sidebar + user/logout + theme/lang; restricted mode filters to forum-only; network sub-nav; Suspense fallback. 🟢 `app/app/layout.tsx:1-135`
- **Sessions Sidebar** — Persistent session tree; new session/project folder; drag-drop; pin/delete/assign-to-project; project grouping; listens neurion:sessions-changed; desktop pickFolder. 🟢 `components/SessionsSidebar.tsx:1-159`
- **i18n** — 7 languages (EN/IT/FR/DE/ES/RU/ZH); useT hook; localStorage; EN fallback; {var} interpolation. 🟢 `lib/i18n.tsx:1-67`
- **Language Toggle** — Switches language; persists; sets documentElement lang. 🟢 `components/LangToggle.tsx:1-67`
- **Theme Toggle (Dark/Light)** — Persists; sets data-theme; CSS-variable theming. 🟢 `lib/theme.tsx` + `components/ThemeToggle.tsx`
- **Authentication (Context)** — useAuth (user, loading, login, register, logout); JWT storage; /auth/me on mount; redirect unauthed. 🟢 `lib/auth.tsx:1-68`
- **Restricted Online Mode** — GET /config check; restricted=true → forum-only + redirect chat/agent/models to account. 🟢 `app/app/layout.tsx:35-51`
- **Cost/Routing Badges** — Chat lane/provider+labeled/privacy/cost badges from routing event. 🟢 `app/app/chat/page.tsx:204-211`
- **Agent Approval Prompts** — Approve/deny tool-call prompts (tool + args JSON), amber-styled. 🟢 `app/app/chat/page.tsx:189-197` + `app/app/agent/page.tsx:98-119`
- **Avatar Display** — Initials fallback or image URL, 56px, in account profile. 🟢 `components/Avatar.tsx`

---

## 7. Desktop Application — Electron (`apps/desktop`)

### Embedded stack & boot
- **Embedded PostgreSQL + DB Setup** — Self-contained Postgres on :5433 (no Docker), UTF-8, persistent userData/pgdata. 🟢 `main.js:32-37,181-223`
- **DB Migration & Seeding** — Prisma migrations every launch; first-run seed; packaged builds use Electron Node runtime + compiled seed.js. 🟢 `main.js:257-280`, `scripts/prepare-stack.mjs:59-65`
- **Runtime JWT Secrets** — Generates/persists access+refresh secrets once per install in userData/secrets.json (0o600). 🟢 `main.js:230-255`
- **Bundled API Server (NestJS)** — Launches API :8091 as child; waits for /api/health; killed on quit. 🟢 `main.js:282-286`
- **Bundled Web Server (Next.js)** — Launches web :3091 as child in prod mode; waits for availability. 🟢 `main.js:288-294`
- **First-Run Splash Screen** — Frameless 420×320 splash w/ progress bar + localized status; IPC JS injection; auto-hides. 🟢 `main.js:177-179,297-307`, `splash.html:1-26`
- **OS Language Localization** — Detects app.getLocale(); EN + IT strings for menu/tray/splash/dialogs; EN fallback. 🟢 `main.js:62-112,488`
- **Graceful Web Server Retry** — Retries WEB_URL every 1s ×25; localized error page on max retries. 🟢 `main.js:324-339`

### Native OS integration
- **Folder Picker Dialog (IPC)** — window.neurion.pickFolder → showOpenDialog; forward-slash paths. 🟢 `main.js:433-440`, `preload.js:5`
- **Single-Instance Lock** — Second launch focuses existing window (avoids port contention). 🟢 `main.js:477-485`
- **System Tray Integration** — Minimize-to-tray; right-click Open/Autostart/Quit; click shows window; graceful icon fallback. 🟢 `main.js:387-411`
- **Minimize-to-Tray** — Window close hides (not quits); stack + node keep running. 🟢 `main.js:349-356`
- **Start-at-Login (Autostart)** — Menu + tray checkbox; Windows setLoginItemSettings(); Linux autostart .desktop file. 🟢 `main.js:358-385,404,421`
- **App Menu Bar** — File/Edit/View/Window submenus, localized. 🟢 `main.js:413-431`
- **About Dialog** — Message box w/ name + description + version (package.json). 🟢 `main.js:418`
- **Preload Bridge (IPC isolation)** — contextBridge exposes isDesktop, pickFolder, node.{status,start,stop}; blocks XSS→Node. 🟢 `preload.js:1-11`
- **Web URL Handling** — target=_blank links → shell.openExternal (system browser). 🟢 `main.js:344-347`

### Bundled node-agent (in-app)
- **In-App Node Agent Registration** — Registers bundled Go binary on prod network (neurionproject.org) once per install; config in userData/neurion-node.yaml; uses user email+password. 🟢 `main.js:449-467`, `preload.js:8-9`
- **In-App Node Start/Stop** — Spawns neurion-node child; connects local ollama (:11434/v1); killed on quit/request. 🟢 `main.js:449-472,512-521`
- **Node Agent Status IPC** — node:status/start/stop via preload; reports running + registration + binary availability. 🟢 `main.js:443-472`, `preload.js:6-9`
- **Bundled Node Binary (Go)** — Cross-platform binary (-trimpath -ldflags='-s -w'), built at pack time if Go present; one-click NRN earning. 🟢 `scripts/prepare-stack.mjs:103-113`

### Packaging
- **Desktop Stack Assembly (prepare-stack.mjs)** — Build-time ESM: compiles API/web, generates Prisma client, installs prod deps --omit=dev, copies .env, builds node binary. 🟢 `scripts/prepare-stack.mjs:1-119`
- **Windows Icon Stamping (afterPack)** — rcedit stamps icon + version on Neurion.exe (Windows only). 🟢 `scripts/after-pack.js:1-32`, `package.json:28`
- **ASAR Packaging** — Single .asar archive; excludes node_modules/staging/scripts. 🟢 `package.json:29,31-38`
- **Multi-Platform Installer Config** — NSIS (exe+msi), AppImage+deb, DMG; one-click off, per-user, shortcuts. 🟢 `package.json:46-79`

---

## 8. Node-Agent, Workers & Infrastructure

### Go node-agent (`apps/node-agent`)
- **neurion-node CLI** — register (login + register, YAML config), start (WS + auto-reconnect), status. 🟢 `cmd/neurion-node/main.go:1-179`
- **Agent core (WS + heartbeat)** — Long-lived WS; 10s heartbeat (CPU/RAM/GPU); handles job.assign + realtime.chat.request. 🟢 `internal/agent/agent.go:31-399`
- **Grid job execution (hardened sandbox)** — Docker per job; allowlisted images, --network none, dropped caps, --read-only rootfs, pids/mem/cpu limits, max 300s. 🟢 `internal/agent/agent.go:271-337`
- **Realtime chat proxy** — Forwards realtime.chat.request to local OpenAI-compatible backend; streams SSE tokens back via WS; backend-unreachable handling. 🟢 `internal/agent/agent.go:339-399`
- **Capability detection** — Advertises OS/arch, CPU, RAM, GPU (nvidia-smi), Docker, loaded models, warmup benchmark. 🟢 `internal/agent/agent.go:46-83`
- **Realtime model discovery** — GET /models on backend; auto-discovers models; skips vision models for benchmark. 🟢 `internal/agent/agent.go:108-166`
- **System telemetry** — Stdlib-only: CPU /proc/stat, RAM /proc/meminfo, GPU via nvidia-smi, CPU model /proc/cpuinfo; degrades on non-Linux. 🟢 `internal/agent/telemetry.go:1-207`
- **Registration helper** — Async register (login + /api/nodes/register) → ready config; used by tray. 🟢 `internal/agent/register.go:41-64`
- **Auto-reconnect loop** — RunLoop wraps agent w/ 3s retry + context cancel. 🟢 `internal/agent/register.go:66-79`
- **YAML config (persistent)** — node + realtime sections; defaults workingDir=./neurion-work, maxConcurrentJobs=1. 🟢 `internal/config/config.go:1-69`
- **neurion-tray (system tray GUI)** — Windows systray: load/register config, creds from file/env, autostart registry, start/stop, open dashboard/settings, serve local ollama models. 🟢 `cmd/neurion-tray/main.go:1-205`
- **node-agent example config** — neurion-node.example.yaml: node setup + realtime backend (ds4/ollama, auto-discover or fixed). 🟢 `neurion-node.example.yaml:1-36`
- **Windows node installer (Inno Setup)** — NeurionNodeSetup.exe per-user (no admin); bundles tray+node exe, desktop shortcut + autostart, x64. 🟢 `installer/neurion.iss:1-48`

### TypeScript grid workers (`apps/workers`)
- **echo-worker (echo.v1)** — Reads input.json, echoes text, outputs timing + peak memory; no external deps. 🟢 `echo-worker/src/run.ts:1-36`
- **embedding-worker (embedding.v1)** — all-MiniLM-L6-v2 (384-dim) via transformers.js; mean pooling + L2 norm; model baked at build time for offline run. 🟢 `embedding-worker/src/run.ts:1-60`
- **Echo worker Docker image** — node:20-alpine, compiled dist, --input/--output contract; tag neurion/echo-worker:0.1.0. 🟢 `echo-worker/Dockerfile:1-8`
- **Embedding worker Docker image** — node:20-slim (glibc), bakes model w/ EMBED_ALLOW_REMOTE, --network none offline load; tag neurion/embedding-worker:0.1.0. 🟢 `embedding-worker/Dockerfile:1-13`

### Build / deploy / CI (`infra`, `.github`)
- **build-workers.sh** — tsc + docker build per worker; echo always, embedding skippable if deps missing. 🟢 `infra/build-workers.sh:1-22`
- **deploy-vps.sh (full deploy)** — 8-step idempotent: pnpm install, prisma gen/migrate, build, seed, systemd units, nginx (SSE/WS proxy), certbot HTTPS. 🟢 `infra/deploy-vps.sh:1-179`
- **deploy-vps environment setup** — Postgres role/db, .dbpass 600, .env.production w/ JWT secrets, admin seed, ollama fallback (qwen2.5:3b). 🟢 `infra/deploy-vps.sh:19-58`
- **VPS nginx vhost** — neurionproject.org: /api/*→8091 (SSE-safe), /ws/*→8091 (WS upgrade), /→3091; static landing. 🟢 `infra/deploy-vps.sh:117-169`
- **systemd units (api, web)** — Type=simple, EnvironmentFile, Restart=always, After=postgresql/ollama. 🟢 `infra/deploy-vps.sh:80-109`
- **Postgres backup script** — Nightly pg_dump (custom format) → /var/backups/neurion, 14-day retention, logged. 🟢 `infra/neurion-pgbackup.sh:1-27`
- **VPS redeploy script** — 6-step: git pull, pnpm install, build, migrate deploy, restart, healthcheck. 🟢 `infra/scripts/deploy.sh:1-28`
- **healthcheck script** — Probes /health + db/redis/storage/contracts/ai-router; exits 1 if core down. 🟢 `infra/scripts/healthcheck.sh:1-15`
- **CI (GitHub Actions)** — api-web (typecheck/build/test) + contracts (hardhat test) + node-agent (go build/vet/test); on main push + PRs. 🟢 `.github/workflows/ci.yml:1-66`
- **Release workflow (multi-platform)** — On v* tags: desktop installers (exe/dmg/AppImage/deb) + node-agent binaries (Win/Linux/macOS) → GitHub release. 🟢 `.github/workflows/release.yml:1-154`

---

## Honest Gaps — Not Live / Partial / Stub

**⚪ Stubs (declared but not wired to real behavior):**
- **GRID lane (AI router)** — Heavy-job lane is recognized by the estimator and a `lane:'GRID'` value is set in `jobs.service.ts`, but `ai-router.service.ts` has no actual GRID routing logic; heavy chat requests don't yet flow into the grid-job pipeline. `ai/estimator.service.ts:12-37`, `jobs/jobs.service.ts:37`
- **K-Replica Consensus** — Multi-worker majority/outlier-slashing logic exists in `verification/helpers.ts:46-89` but is not invoked by the live single-worker verification path (MVP runs 1 replica, escalates to trusted executor instead).
- **Admin Dashboard (web)** — `/app/admin` only fetches the endpoint and dumps raw JSON; no real admin UI. `app/app/admin/page.tsx:1-24`

**🟡 Partial:**
- **POST /projects/pick-folder** — Native folder picker is Windows/desktop-only; no cross-platform or web-mode equivalent. `projects/projects.controller.ts:82-85`
- **Forum Threads (public + app thread views)** — `forum/[id]` and `app/forum/[id]` thread pages are thin/incomplete relative to the board listing (reply path minimally wired). `app/forum/[id]/page.tsx`, `app/app/forum/[id]/page.tsx`
- **Registration Challenge & PoW** — DB model + lifecycle (STAKE/POW, difficulty bits, velocity cap) exist in schema, but only the STAKE bond path is enforced at registration; the PoW friction path is not fully wired in `nodes.service.ts`. `schema.prisma:797-830`

**🔴 Disabled / gated by feature flags (intentionally off by default):**
- **TOKEN_PAYOUTS_ENABLED** — All on-chain NRN emission (request-payout + process-payouts) throws `Forbidden` until this flag is set; default false. `token-config.service.ts:22-24`
- **PROTOCOL_FEE_BPS / PROTOCOL_REWARD_FEE_BPS** — Protocol take-rate defaults to 0 (fee mechanism present but off). `credits/credits.service.ts:31-55`
- **Embedding deep-verification (VERIFY_EMBEDDING_ENABLED)** — When disabled, embedding jobs fall through to provisional verification (score 0.5, NRN withheld) rather than true L2 cosine re-execution. `verification/trusted-executor.service.ts:15-53`
- **Sub-Frontier ds4/DwarfStar provider** — Only active if an AI_DS4_BASE_URL backend is reachable; otherwise the network silently runs ollama or labeled mock. `provider-resolver.service.ts:28-34`

**Notable observations:**
- Disabled/"Coming soon" job types beyond `echo.v1` + `embedding.v1` (audio/OCR/image) are registry-gated out of MVP (`ENABLED_TYPES`), consistent with the G4 scope decision.
- The MockProvider is intentionally always-labeled (loud banner) so a mock answer can never masquerade as a real model response.