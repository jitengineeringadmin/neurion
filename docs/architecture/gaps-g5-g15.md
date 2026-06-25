# Neurion Gaps G5–G15 — Resolutions

**Status:** decided (2026-06-25) · **Spec ref:** `NEURION_SPEC_Codex_IT_EN_v1.1.md` · **Owner:** JIT / Giacomo Rossi

Resolves gaps G5–G15 via per-gap solver + adversarial review + finalize (33 agents). G1/G2 in separate docs ([verification-g1.md](verification-g1.md), [privacy-g2.md](privacy-g2.md)); G3/G4 in memory.

## Summary

| Gap | Title | Severity | Review verdict | Findings folded |
|-----|-------|----------|----------------|-----------------|
| G5 | Sybil / abuse defense for node onboarding + reward farming | high | revise | 11 |
| G6 | Refresh-token revocation / session model | high | revise | 7 |
| G7 | Attachment model + storage wiring + retention | high | revise | 12 |
| G8 | Pre-routing cost/heaviness estimator | medium | revise | 8 |
| G9 | ChatMessage.linkedJobId relation | medium | ship | 4 |
| G10 | Cost reconciliation: estimate vs actual | medium | revise | 8 |
| G11 | WebSocket/SSE bridge horizontal scaling | medium | revise | 7 |
| G12 | Reward emission rate-limit vs Compute Rewards Pool | medium | revise | 8 |
| G13 | TOKEN_PAYOUTS_ENABLED missing from env | low | revise | 6 |
| G14 | Reward signer key custody | low | revise | 4 |
| G15 | GPU/worker job isolation on community hardware | low | revise | 9 |

---

Confirmed: `NodeStatus` is `{OFFLINE,ONLINE,BUSY,DEGRADED,DISABLED,BANNED}`, `CreditLedger` has no idempotency key, `ComplianceRecord` has no `workspaceId`/enum status, and no `WorkspaceConfig` exists. All review findings are valid. Here is the final resolution.

### G5 — Sybil / abuse defense for node onboarding + reward farming

**Decision:** Make the OWNER (User), not the node, the unit of trust, exposure, and gating, and put a hard cost on registration plus a hard KYC gate on cash-out. Seven controls: (1) refundable internal-credit registration stake (PoW fallback for anon flows), rate-limited per owner; (2) per-owner node cap; (3) `OwnerReputation` keystone — new nodes inherit `min(node, owner)` trust band, one deep-FAIL drags all owner nodes; (4) per-owner outstanding-unverified credit cap (over cap => reward withheld as `PENDING_VERIFIED`, never optimistic); (5) BullMQ velocity/anomaly monitor => `ComplianceRecord` + soft `payoutHold` (fail-safe-up); (6) hard `KYC_APPROVED` gate on NRN payout above `kycPayoutThresholdCredits`; (7) subnet(/24)+hardware-fingerprint dedup => forced COMMUNITY + ComplianceRecord. Composes with G1 (per-node probation/retro-audit/clawback stay; G5 is the owner envelope around them). Controls 1–4+6 are MVP-blocking; 5+7 ship as the anomaly worker immediately after.

Folding in all blocker/high findings, the canonical corrections are: **PROBATION is NOT a `NodeStatus`** — add a separate `lifecycleState NodeLifecycle` (G1-owned field name; confirmed `NodeStatus` is liveness-only `{OFFLINE,ONLINE,BUSY,DEGRADED,DISABLED,BANNED}`); fix the `OwnerReputation` relations (real `Workspace`/`User` FKs + back-relations); add an `idempotencyKey` to `CreditLedger` so the stake debit and 2-phase register are retry-safe; **fail-safe-up everywhere** (missing owner aggregate => withhold, not grant); **explicit `SELECT … FOR UPDATE` on the `OwnerReputation` row** at tx start to close the cap/credit TOCTOU race (GA-blocking, not deferred); seed `WorkspaceConfig` deterministically; and enforce `PAYOUT_BLOCKED`/`KYC_REJECTED` independent of threshold in the payout gate.

**Prisma deltas:**
```prisma
// === G5 deltas (additive; cuid/@default style matches existing schema) ===

// --- ComputeNode additions (G1 owns lifecycleState; G5 references it) ---
// Append to model ComputeNode:
//   lifecycleState      NodeLifecycle @default(PROBATION)   // orthogonal to status(NodeStatus) liveness
//   registrationIp      String?
//   subnet24Hash        String?
//   hardwareFingerprint String?
//   stakeChallengeId    String?  @unique
//   @@index([subnet24Hash])
//   @@index([hardwareFingerprint])

enum NodeLifecycle {   // NEW — do NOT overload NodeStatus{OFFLINE,ONLINE,BUSY,DEGRADED,DISABLED,BANNED}
  PROBATION
  ACTIVE
  SUSPENDED
}

// --- User additions (KYC fields already exist) ---
// Append to model User:
//   payoutHold      Boolean          @default(false)
//   ownerReputation OwnerReputation? @relation("OwnerRepUser")

// --- Workspace additions ---
// Append to model Workspace:
//   ownerReputations OwnerReputation[]
//   config           WorkspaceConfig?

// --- CreditLedger: add idempotency (multiple NULL jobIds are NOT unique in PG) ---
// Append to model CreditLedger:
//   idempotencyKey String? @unique   // pass challenge.id for stake debit/refund; client req-id for register

// 1) Keystone: per-owner aggregate. One row per node-owning User.
model OwnerReputation {
  id                                String    @id @default(cuid())
  workspaceId                       String
  userId                            String    @unique
  nodeCount                         Int       @default(0)   // authoritative count; mutate under FOR UPDATE
  effectiveReputation               Float     @default(0)   // worst-case band; clamped [0,1]
  ownerOutstandingOptimisticCredits Int       @default(0)
  lifetimeUnverifiedCredits         Int       @default(0)
  lifetimePayoutCredits             Int       @default(0)
  deepFailCount                     Int       @default(0)
  payoutHold                        Boolean   @default(false)
  lastRegistrationAt                DateTime?
  registrationsToday                Int       @default(0)
  registrationsDayKey               String?                 // UTC yyyy-mm-dd; reset when key rolls
  createdAt                         DateTime  @default(now())
  updatedAt                         DateTime  @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id])
  user      User      @relation("OwnerRepUser", fields: [userId], references: [id])

  @@index([workspaceId])
}

// 2) Registration challenge (refundable stake OR PoW).
model RegistrationChallenge {
  id            String                      @id @default(cuid())
  workspaceId   String
  userId        String
  kind          RegistrationChallengeKind   @default(STAKE)
  status        RegistrationChallengeStatus @default(PENDING)
  stakeCredits  Int                         @default(0)
  powChallenge  String?
  powDifficulty Int?
  powSolution   String?
  nodeId        String?
  expiresAt     DateTime
  createdAt     DateTime                    @default(now())
  resolvedAt    DateTime?

  @@index([userId, status])
}

enum RegistrationChallengeKind { STAKE POW }
enum RegistrationChallengeStatus { PENDING SOLVED CONSUMED REFUNDED FORFEITED EXPIRED }

// 5) Per-workspace tuning knobs. Seed one row on workspace creation.
model WorkspaceConfig {
  id                                   String   @id @default(cuid())
  workspaceId                          String   @unique
  maxNodesPerOwner                     Int      @default(5)
  maxNodeRegistrationsPerDay           Int      @default(3)
  registrationStakeCredits             Int      @default(50)
  powDifficultyBits                    Int      @default(20)
  maxOwnerOutstandingUnverifiedCredits Int      @default(500)
  kycPayoutThresholdCredits            Int      @default(1000)
  maxNodesPerSubnet24                  Int      @default(3)
  maxNodesPerFingerprint               Int      @default(2)
  createdAt                            DateTime @default(now())
  updatedAt                            DateTime @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id])
}

// ComplianceRecord: reused as-is (type/status free String). New type values:
//   "SYBIL_VELOCITY","REWARD_FARMING","SUBNET_FANOUT","FINGERPRINT_COLLISION".
//   Status lifecycle (documented, no enum): OPEN -> UNDER_REVIEW -> RESOLVED|DISMISSED.
//   Worker must check for existing OPEN record (userId+type) before inserting.
```

**Code:**
```ts
// === G5 — NestJS (matches existing service/Prisma style) ===

// --- 1+2+7: two-phase register with FOR UPDATE owner lock, cap, rate-limit, stake, dedup ---
async registerNode(user: AuthUser, dto: RegisterNodeDto, req: ReqMeta, reqId: string) {
  const cfg = await this.config.get(user.workspaceId); // deterministic: upserts defaults, never null
  return this.prisma.$transaction(async (tx) => {
    // Idempotent register: a retried 2-phase submit returns the existing node, never a 2nd nodeKey.
    const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey: reqId } });
    if (existing) {
      const n = await tx.computeNode.findFirst({ where: { ownerUserId: user.id, stakeChallengeId: { not: null } }, orderBy: { createdAt: 'desc' } });
      return { node: n, nodeKey: null, replayed: true }; // nodeKey only ever returned once (§20.1)
    }

    // Ensure aggregate exists, then LOCK the owner row — closes cap/credit/rate TOCTOU (Finding: FOR UPDATE).
    await tx.ownerReputation.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, workspaceId: user.workspaceId, effectiveReputation: 0 },
    });
    const [owner] = await tx.$queryRaw<OwnerReputation[]>`
      SELECT * FROM "OwnerReputation" WHERE "userId" = ${user.id} FOR UPDATE`;

    // per-owner node cap (raised by KYC); count derived from LOCKED aggregate, not a racy count()
    const cap = user.kycStatus === 'KYC_APPROVED' ? cfg.maxNodesPerOwner * 3 : cfg.maxNodesPerOwner;
    if (owner.nodeCount >= cap) throw new ForbiddenException('NODE_CAP_REACHED');

    // per-owner registration rate-limit (UTC-day bucket on the locked row)
    const dayKey = utcDayKey(new Date());
    const regsToday = owner.registrationsDayKey === dayKey ? owner.registrationsToday : 0;
    if (regsToday >= cfg.maxNodeRegistrationsPerDay) throw new ForbiddenException('REGISTRATION_RATE_LIMIT');

    // subnet / fingerprint dedup (advisory => forced COMMUNITY + ComplianceRecord, never hard-block)
    const subnet = sha256(`${user.workspaceId}:${slash24(req.ip)}`);
    const fp = sha256([dto.cpuModel, dto.cpuCores, dto.ramMb, dto.gpuModel, dto.os, dto.arch].join('|'));
    const [subnetCount, fpCount] = await Promise.all([
      tx.computeNode.count({ where: { workspaceId: user.workspaceId, subnet24Hash: subnet } }),
      tx.computeNode.count({ where: { workspaceId: user.workspaceId, hardwareFingerprint: fp } }),
    ]);
    const flagged = subnetCount >= cfg.maxNodesPerSubnet24 || fpCount >= cfg.maxNodesPerFingerprint;

    // refundable stake (unproven owners only)
    if (owner.lifetimePayoutCredits === 0) {
      const bal = await this.credits.balance(tx, user.id);
      if (bal < cfg.registrationStakeCredits) throw new ForbiddenException('INSUFFICIENT_STAKE');
    }

    const nodeKey = generateNodeKey();
    const node = await tx.computeNode.create({
      data: {
        workspaceId: user.workspaceId, ownerUserId: user.id, name: dto.name,
        nodeKeyHash: hashNodeKey(nodeKey),
        lifecycleState: 'PROBATION',          // G1 lifecycle, NOT NodeStatus
        trustLevel: 'COMMUNITY',              // forced COMMUNITY (flagged or not, fresh node)
        reputationScore: owner.effectiveReputation, // inherit owner band
        registrationIp: req.ip, subnet24Hash: subnet, hardwareFingerprint: fp,
      },
    });

    const challenge = await tx.registrationChallenge.create({
      data: { workspaceId: user.workspaceId, userId: user.id, nodeId: node.id, kind: 'STAKE',
              status: 'CONSUMED', stakeCredits: cfg.registrationStakeCredits, expiresAt: addDays(new Date(), 30) },
    });
    await tx.computeNode.update({ where: { id: node.id }, data: { stakeChallengeId: challenge.id } });

    // idempotent stake debit (keyed on reqId so a network retry can't double-debit)
    await this.credits.spend(tx, { userId: user.id, amount: cfg.registrationStakeCredits,
      reason: 'NODE_REGISTRATION_STAKE', idempotencyKey: reqId });

    await tx.ownerReputation.update({ where: { userId: user.id }, data: {
      nodeCount: { increment: 1 }, lastRegistrationAt: new Date(),
      registrationsDayKey: dayKey, registrationsToday: regsToday + 1 } });

    if (flagged) {
      const existsOpen = await tx.complianceRecord.findFirst({ where: { userId: user.id,
        type: subnetCount >= cfg.maxNodesPerSubnet24 ? 'SUBNET_FANOUT' : 'FINGERPRINT_COLLISION', status: 'OPEN' } });
      if (!existsOpen) await tx.complianceRecord.create({ data: { userId: user.id,
        type: subnetCount >= cfg.maxNodesPerSubnet24 ? 'SUBNET_FANOUT' : 'FINGERPRINT_COLLISION',
        status: 'OPEN', data: { nodeId: node.id, subnetCount, fpCount } } });
    }
    await this.audit.log(tx, { actorUserId: user.id, action: 'NODE_REGISTER', entityType: 'ComputeNode',
      entityId: node.id, ipAddress: req.ip, data: { flagged, stakeCredits: cfg.registrationStakeCredits } });

    return { node, nodeKey, replayed: false }; // nodeKey returned exactly once
  });
}

// --- 3+4: owner outstanding-unverified gate (fail-safe-up). Called before G1 grants optimistic credit. ---
async canGrantOptimisticCredit(tx, ownerUserId: string, amount: number, cfg: WorkspaceConfig): Promise<boolean> {
  const o = await tx.ownerReputation.findUnique({ where: { userId: ownerUserId } });
  if (!o) return false;                       // missing aggregate => withhold (PENDING_VERIFIED), then backfill
  if (o.payoutHold) return false;
  return (o.ownerOutstandingOptimisticCredits + amount) <= cfg.maxOwnerOutstandingUnverifiedCredits;
}

// --- G1 deep-verify settle hook: decrement on PASS; forfeit stake + drag owner band on FAIL ---
async onDeepVerifyResult(tx, node, passed: boolean, credits: number) {
  if (passed) {
    await tx.ownerReputation.update({ where: { userId: node.ownerUserId },
      data: { ownerOutstandingOptimisticCredits: { decrement: credits } } });
    return;
  }
  // pre-graduation stake forfeiture (post-graduation stake already REFUNDED => no-op; rely on G1 clawback)
  await tx.registrationChallenge.updateMany({ where: { nodeId: node.id, status: 'CONSUMED' }, data: { status: 'FORFEITED' } });
  const o = await tx.ownerReputation.findUnique({ where: { userId: node.ownerUserId } });
  const next = clamp01((o?.effectiveReputation ?? 0) - 0.3); // clamp [0,1]; reconcile decrement w/ G1 EWMA
  await tx.ownerReputation.update({ where: { userId: node.ownerUserId },
    data: { deepFailCount: { increment: 1 }, effectiveReputation: next } });
  await tx.user.update({ where: { id: node.ownerUserId }, data: { payoutHold: true } });
}

// --- stake refund on probation graduation (verifiedJobCount>=30); idempotent, exactly-once ---
async refundRegistrationStakeOnGraduation(tx, node) {
  if (node.verifiedJobCount < 30 || !node.stakeChallengeId) return;
  const c = await tx.registrationChallenge.updateMany({
    where: { id: node.stakeChallengeId, status: 'CONSUMED' }, data: { status: 'REFUNDED', resolvedAt: new Date() } });
  if (c.count === 0) return; // already refunded/forfeited
  await this.credits.refund(tx, { userId: node.ownerUserId, amount: node.stakeChallengeStakeCredits,
    reason: 'NODE_REGISTRATION_STAKE_REFUND', idempotencyKey: `refund:${node.stakeChallengeId}` });
}

// effective trust for scheduler / G2 trust-set
function effectiveNodeTrust(node, owner) { return Math.min(node.reputationScore, owner.effectiveReputation); }

// --- 5: velocity/anomaly monitor (BullMQ repeatable, every 5m), de-duped OPEN records ---
@Processor('owner-anomaly')
export class OwnerAnomalyProcessor {
  async process() {
    const owners = await this.prisma.ownerReputation.findMany({ where: { payoutHold: false } });
    for (const o of owners) {
      const w1h = await this.metrics.ownerRewardVelocity(o.userId, 3600_000);
      const acctAgeH = hoursSince(await this.acctCreatedAt(o.userId));
      const minValShare = await this.metrics.minValueJobShare(o.userId, 86_400_000);
      const suspicious = w1h > THRESH.rewardPerHour ||
        (acctAgeH < 24 && o.lifetimeUnverifiedCredits > THRESH.youngEarn) ||
        minValShare > 0.9 || o.registrationsToday > THRESH.regBurst;
      if (!suspicious) continue;
      const type = w1h > THRESH.rewardPerHour ? 'REWARD_FARMING' : 'SYBIL_VELOCITY';
      const open = await this.prisma.complianceRecord.findFirst({ where: { userId: o.userId, type, status: 'OPEN' } });
      await this.prisma.$transaction([
        ...(open ? [] : [this.prisma.complianceRecord.create({ data: { userId: o.userId, type, status: 'OPEN',
          data: { w1h, acctAgeH, minValShare } } })]),
        this.prisma.ownerReputation.update({ where: { userId: o.userId }, data: { payoutHold: true } }),
        this.prisma.user.update({ where: { id: o.userId }, data: { payoutHold: true } }), // fail-safe-up
      ]);
    }
  }
}

// --- 6: hard KYC payout gate (TokenPayout path); blocks PAYOUT_BLOCKED/KYC_REJECTED regardless of threshold ---
async createPayout(tx, user: User, amountCredits: number, cfg: WorkspaceConfig) {
  if (user.payoutHold) throw new ForbiddenException('PAYOUT_HOLD');
  if (user.kycStatus === 'PAYOUT_BLOCKED' || user.kycStatus === 'KYC_REJECTED')
    throw new ForbiddenException('PAYOUT_BLOCKED'); // honored independent of threshold
  // LOCK aggregate so concurrent payouts can't both slip under threshold
  const [o] = await tx.$queryRaw<OwnerReputation[]>`
    SELECT * FROM "OwnerReputation" WHERE "userId" = ${user.id} FOR UPDATE`;
  const projected = (o?.lifetimePayoutCredits ?? 0) + amountCredits;
  if (projected > cfg.kycPayoutThresholdCredits && user.kycStatus !== 'KYC_APPROVED') {
    if (user.kycStatus === 'KYC_NOT_REQUIRED' || user.kycStatus === 'KYC_REQUIRED')
      await tx.user.update({ where: { id: user.id }, data: { kycStatus: 'KYC_REQUIRED' } });
    throw new ForbiddenException('KYC_REQUIRED_FOR_PAYOUT');
  }
  // ...existing G1 post-VERIFIED TokenPayout create (same tx)...
  await tx.ownerReputation.update({ where: { userId: user.id }, data: { lifetimePayoutCredits: { increment: amountCredits } } });
}
```

**Spec patch:**
- **§10.4 Nodes** — replace the single `POST /api/nodes/register` line with the 2-phase flow: `POST /api/nodes/register` (issues `RegistrationChallenge` STAKE|POW; enforces `maxNodesPerOwner` + `maxNodeRegistrationsPerDay` under a `FOR UPDATE` owner lock; records `registrationIp`/`subnet24Hash`/`hardwareFingerprint`; node created with `lifecycleState=PROBATION` per G1; nodeKey returned once; idempotent on client request id), `POST /api/nodes/register/solve` (submit PoW / confirm stake; consumes challenge), `GET /api/nodes/owner-exposure` (owner aggregate). Add prose: "Unproven owners post a refundable internal-credit stake (default 50), auto-refunded on probation graduation (`verifiedJobCount>=30`), forfeited on pre-graduation deep-verify FAIL; post-graduation FAIL relies on G1 clawback + owner band drop, not stake. Anon/headless flows use a hashcash PoW of `powDifficultyBits`. New nodes inherit the owner's `effectiveReputation`; per-owner trust/exposure/holds aggregate in `OwnerReputation`. `PROBATION` is a `NodeLifecycle` state orthogonal to `NodeStatus` liveness."
- **§8 Schema** — add `enum NodeLifecycle { PROBATION ACTIVE SUSPENDED }`, `ComputeNode.lifecycleState`, the sybil/dedup fields, `OwnerReputation`, `RegistrationChallenge`, `WorkspaceConfig`, `CreditLedger.idempotencyKey @unique`, `User.payoutHold`. Note `NodeStatus` stays `{OFFLINE,ONLINE,BUSY,DEGRADED,DISABLED,BANNED}` (liveness only).
- **§16.6** — append a bullet to the list (not "under Phase B/C"): "NRN payout requires `KYC_APPROVED` once cumulative owner payout exceeds `kycPayoutThresholdCredits` (default 1000 ≈ 100 NRN); below threshold internal/testnet credits only." Cross-ref `PAYOUT_BLOCKED`/`KYC_REJECTED` are honored independent of threshold; `payoutHold` is an orthogonal soft freeze distinct from `kycStatus`.
- **§18.2 (payout flow)** — insert the KYC-threshold gate + `payoutHold`/`PAYOUT_BLOCKED` checks as a payout-flow step (this is the real prose anchor, not §16).
- **§19.2 Product controls** — append the seven controls. **§19.1 Docs** — add "KYC/AML procedure note: identity verification triggered at payout threshold; retention per ComplianceRecord."
- **§20.1 Node security** — append rate-limit/cap, refundable stake-or-PoW, ip/subnet/fingerprint recording. **New §20.5 Anti-sybil/abuse** — summarize controls 1–7, point to `OwnerReputation` + `WorkspaceConfig` as the single tuning surface; document `ComplianceRecord` status lifecycle `OPEN→UNDER_REVIEW→RESOLVED|DISMISSED`.

**Known limitations:**
- KYC-arbitrage: a determined attacker can clear the §18.2 gate with one real/mule identity per owner — G5 collapses the sybil multiplier to ~1/identity (uneconomic at MVP rewards) but not to zero; defer liveness/duplicate-face checks at the KYC provider.
- Stake is internal credits: an attacker with a large legit balance can fund many registrations cheaply (refunded on graduation); bounded by cap + rate-limit, backstopped by G1 retro-audit/clawback + forfeiture + owner-wide band drop.
- Control 7 (subnet/fingerprint) is detection-only (advisory, forces COMMUNITY) — residential proxies/spoofed hardware evade it; kept non-blocking to avoid CGNAT false-positive lockout.
- Anomaly thresholds are static config in MVP; a slow-drip attacker tuned just under `THRESH` evades the monitor, but control 4 (per-owner outstanding cap) + G1 probation deep-verify bound total extractable float, caught at the payout-threshold KYC.
- Owner-reputation contagion is intentionally collective (one node's FAIL holds all owner nodes) — risk of punishing a legit operator with one compromised node; mitigated by `payoutHold`-not-ban + COMPLIANCE manual review (reversible).
- `effectiveReputation` flat `-0.3` decrement is a placeholder clamped to `[0,1]`; reconcile with G1's EWMA formula and define the Float→trust-band (COMMUNITY/VERIFIED) mapping once, shared with G2, before GA.

---

This is a synthesis task — fold the high/blocker review findings into a final artifact. No file exploration needed; I have everything. Let me produce the final resolution.

### G6 — Refresh-token revocation / session model

**Decision:** Stateful, rotating opaque refresh tokens with family-based reuse detection. Refresh token = `<id>.<secret>` (app-generated cuid2 id + 32-byte base64url secret); server stores only `sha256(secret)`. Access token stays a 15m JWT, unchanged. Cookie is httpOnly+Secure+SameSite=Strict, **path-scoped to `/api/auth`** (so it reaches login/refresh/logout but no other route). Every `/api/auth/refresh` rotates: the presented row is atomically claimed (`updateMany where revokedAt:null AND expiresAt>now`) and a new row issues in the same `familyId`. Presenting an already-revoked/expired/lost-the-race token ⇒ THEFT ⇒ revoke the whole family and force re-login. The family root id is written atomically in the same `create` (no `'PENDING'` sentinel) to eliminate cross-tenant family collisions. Reuse-detection and family revokes write an `AuditLog` (in the same transaction on the race path). Logout revokes the current family; `logout-all` / password-change / role-change call `revokeAllForUser`, which also bounds the stale-role window of in-flight access JWTs to ≤15m. Postgres is the source of truth (single-VPS MVP, no extra session store). Does not change G1–G4.

**Prisma deltas:**
```prisma
// §9.1, immediately after model User. Also add to model User:  refreshTokens RefreshToken[]

model RefreshToken {
  id            String   @id                       // app-generated cuid2; family root == this id
  userId        String
  familyId      String                             // lineage root id (atomically == id at creation)
  tokenHash     String   @unique                   // sha256(secret), hex
  expiresAt     DateTime
  revokedAt     DateTime?
  revokedReason RefreshRevokeReason?
  replacedById  String?  @unique                   // id of the token that rotated this one
  userAgent     String?
  ipHash        String?                            // sha256(ip + serverSalt); never raw IP (§20.4)
  createdAt     DateTime @default(now())

  user          User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  replacedBy    RefreshToken? @relation("RefreshLineage", fields: [replacedById], references: [id])
  replaces      RefreshToken? @relation("RefreshLineage")

  @@index([userId])
  @@index([familyId])
  @@index([userId, revokedAt])   // fast "revoke all active for user"
  @@index([expiresAt])           // supports daily cleanup sweep
}

enum RefreshRevokeReason {
  LOGOUT
  ROTATED            // normal rotation (superseded by replacedById)
  REUSE_DETECTED     // theft signal -> whole family revoked
  LOGOUT_ALL         // global revoke-all-sessions
  PASSWORD_CHANGE
  ADMIN_REVOKE
  EXPIRED            // written by the expiry sweep (see code)
}
// Additive migration: new table + enum + one relation field on User. No backfill.
```

**Code:**
```ts
// auth-token.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { RefreshRevokeReason, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { createId } from '@paralleldrive/cuid2';

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const ACCESS_TTL = '15m';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface IssuedSession { refreshCookieValue: string; accessToken: string; }
interface ReqCtx { userAgent?: string; ipHash?: string; }

@Injectable()
export class AuthTokenService {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}

  private async signAccess(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId }, select: { id: true, role: true, workspaceId: true },
    });
    return this.jwt.signAsync(
      { sub: u.id, role: u.role, ws: u.workspaceId },
      { expiresIn: ACCESS_TTL, secret: process.env.JWT_ACCESS_SECRET },
    );
  }

  private async audit(
    tx: Prisma.TransactionClient | PrismaService,
    userId: string, familyId: string, reason: RefreshRevokeReason, ctx?: ReqCtx,
  ) {
    await tx.auditLog.create({
      data: {
        action: 'REFRESH_FAMILY_REVOKED', actorUserId: userId,
        meta: { familyId, reason, ipHash: ctx?.ipHash, userAgent: ctx?.userAgent },
      },
    });
  }

  /** Open a brand-new family. Called by login / SIWE auth. Atomic — no sentinel. */
  async startSession(userId: string, ctx: ReqCtx): Promise<IssuedSession> {
    const id = createId();
    const secret = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        id, familyId: id, userId, tokenHash: sha256(secret),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        userAgent: ctx.userAgent, ipHash: ctx.ipHash,
      },
    });
    return { refreshCookieValue: `${id}.${secret}`, accessToken: await this.signAccess(userId) };
  }

  /** Rotate on /api/auth/refresh. Fail-closed; reuse/expiry => kill family. */
  async rotate(cookieValue: string | undefined, ctx: ReqCtx): Promise<IssuedSession> {
    const [id, secret] = (cookieValue ?? '').split('.');
    if (!id || !secret) throw new UnauthorizedException('NO_REFRESH');

    const current = await this.prisma.refreshToken.findUnique({ where: { id } });
    if (!current || current.tokenHash !== sha256(secret)) {
      throw new UnauthorizedException('INVALID_REFRESH'); // unknown id or wrong secret
    }

    // Already revoked or expired at read time => theft. Burn family + audit.
    if (current.revokedAt || current.expiresAt < new Date()) {
      await this.prisma.$transaction(async (tx) => {
        await tx.refreshToken.updateMany({
          where: { familyId: current.familyId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: RefreshRevokeReason.REUSE_DETECTED },
        });
        await this.audit(tx, current.userId, current.familyId, RefreshRevokeReason.REUSE_DETECTED, ctx);
      });
      throw new UnauthorizedException('REFRESH_REUSE_DETECTED');
    }

    const newId = createId();
    const newSecret = randomBytes(32).toString('base64url');

    const issued = await this.prisma.$transaction(async (tx) => {
      // Atomic claim: expiry enforced INSIDE the guard, not just the pre-read.
      const claimed = await tx.refreshToken.updateMany({
        where: { id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date(), revokedReason: RefreshRevokeReason.ROTATED },
      });
      if (claimed.count !== 1) {
        // Lost the race / expired between read and claim => reuse signal. Burn + audit atomically.
        await tx.refreshToken.updateMany({
          where: { familyId: current.familyId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: RefreshRevokeReason.REUSE_DETECTED },
        });
        await this.audit(tx, current.userId, current.familyId, RefreshRevokeReason.REUSE_DETECTED, ctx);
        throw new UnauthorizedException('REFRESH_REUSE_DETECTED');
      }
      const next = await tx.refreshToken.create({
        data: {
          id: newId, familyId: current.familyId, userId: current.userId,
          tokenHash: sha256(newSecret), expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
          userAgent: ctx.userAgent, ipHash: ctx.ipHash,
        },
      });
      await tx.refreshToken.update({ where: { id }, data: { replacedById: next.id } });
      return next;
    });

    return {
      refreshCookieValue: `${issued.id}.${newSecret}`,
      accessToken: await this.signAccess(current.userId),
    };
  }

  /** Logout: revoke current family only. */
  async logout(cookieValue: string | undefined): Promise<void> {
    const [id] = (cookieValue ?? '').split('.');
    if (!id) return;
    const row = await this.prisma.refreshToken.findUnique({
      where: { id }, select: { userId: true, familyId: true },
    });
    if (row) await this.revokeFamily(row.userId, row.familyId, RefreshRevokeReason.LOGOUT);
  }

  /** Global revoke-all for a user (password change, role change, compromise, admin). */
  async revokeAllForUser(userId: string, reason: RefreshRevokeReason = RefreshRevokeReason.LOGOUT_ALL) {
    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason },
      });
      await this.audit(tx, userId, '*', reason);
    });
  }

  private async revokeFamily(userId: string, familyId: string, reason: RefreshRevokeReason) {
    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({
        where: { familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason },
      });
      await this.audit(tx, userId, familyId, reason);
    });
  }
}

// ---- controller wiring (auth.controller.ts) ----
const REFRESH_COOKIE = 'neurion_rt';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const cookieOpts = {
  httpOnly: true, secure: true, sameSite: 'strict' as const,
  path: '/api/auth', maxAge: REFRESH_TTL_MS,   // path '/api/auth' so cookie reaches login/refresh/logout
};
const ipHashOf = (ip: string) => sha256(ip + process.env.IP_HASH_SALT);
// POST /api/auth/login   -> startSession(); res.cookie(REFRESH_COOKIE, val, cookieOpts); return {accessToken}
// POST /api/auth/refresh -> rotate(req.cookies[REFRESH_COOKIE], {userAgent, ipHash}); reset cookie; on
//                           UnauthorizedException -> res.clearCookie(REFRESH_COOKIE, cookieOpts)
// POST /api/auth/logout  -> logout(cookie); res.clearCookie(REFRESH_COOKIE, cookieOpts)
// POST /api/auth/logout-all (guarded) -> revokeAllForUser(req.user.sub)
// password-change & role-change handlers -> revokeAllForUser(userId, PASSWORD_CHANGE | ADMIN_REVOKE)

// ---- daily BullMQ sweep (retains revoked rows for theft detection) ----
// 1) mark expired-but-unrevoked: updateMany where {revokedAt:null, expiresAt:{lt:now}}
//    data {revokedAt:now, revokedReason:EXPIRED}
// 2) hard-delete only fully-dead families: deleteMany where {revokedAt:{not:null}, expiresAt:{lt: now - 30d}}
//    -> a replayed token still resolves to a row within its original TTL, preserving REUSE_DETECTED.
```

**Spec patch:**
- **§9.1** — insert the `RefreshToken` model + `RefreshRevokeReason` enum above; add `refreshTokens RefreshToken[]` to `model User` relations.
- **§10.1** — endpoint list: `register, login, logout (revokes current family), logout-all (guarded, revoke all sessions), me, refresh (rotates; reuse-detection burns family)`. Note: "Refresh token is opaque `<id>.<secret>`; server stores `sha256(secret)`. Every `/refresh` rotates. A revoked/expired token presented again is theft: the whole family is revoked and the client must re-login."
- **§6.1** — Auth line: "JWT access (15m) + stateful rotating refresh token in httpOnly Secure cookie (RefreshToken table, reuse-detection)."
- **§20.2** — replace the refresh bullet with: httpOnly Secure SameSite=Strict cookie **path-scoped to `/api/auth`**; stateful tokens storing `sha256(secret)` only; rotation on every refresh; reuse-detection revokes the entire family (audited via `AuditLog action=REFRESH_FAMILY_REVOKED`); logout revokes current family, logout-all + password/role change call `revokeAllForUser`; 15m access TTL bounds revocation and stale-role window; session IP stored only as salted `sha256` (`ipHash`), userAgent recorded.
- **§20.4** — add: "session IPs stored as salted `sha256` (`ipHash`), never plaintext." Reconcile existing `AuditLog.ipAddress` (L903): either hash it to match this policy or explicitly document it as the audited-exemption field.

**Known limitations:** (1) Access-JWT revocation latency ≤15m after family/all revoke — future hardening: per-user `tokenVersion` or Redis deny-list in the JWT guard. (2) Rotation-race false positives (parallel tabs / retry after network blip) can burn a family; mitigated by SameSite=Strict + single-flight refresh on the frontend (TanStack Query dedupe); no grace window by design. (3) `sha256` (not argon2) for refresh secrets is correct given 256-bit server-generated entropy — not a password-hashing downgrade. (4) No session-list UI in MVP (`userAgent`/`ipHash` captured for it). (5) Cleanup sweep retains revoked rows for the full TTL before deletion to preserve theft detection on older replays; unbounded growth only if the sweep is skipped (low risk at MVP scale). (6) `§20.4` vs `AuditLog.ipAddress` plaintext must be reconciled in the spec edit, not in code.

---

### G7 — Attachment model + storage wiring + retention

**Decision:**
Add a first-class `Attachment` model with a presigned **direct-to-S3 POST** upload (server-enforced content-length-range + content-type) and an explicit server-side `confirm`, then a `SCANNED` gate before any attachment may feed a prompt, plus an hourly retention sweeper. Folding in all blocker/high findings:

1. **No placeholder unique collision.** The id/objectKey are computed in-app *before* insert; the row is created once with its final unique `objectKey`. No shared `'pending'` literal ever touches a `@unique` column.
2. **Direct upload via presigned POST**, not PUT. MinIO/S3 enforces `content-length-range` (0…25 MB) and an exact `Content-Type` condition *at upload time* — disk-exhaustion DoS closed at the door, not at confirm.
3. **Server-chosen mime is authoritative.** The mime the server signed into the POST policy is persisted at presign and is the value re-validated (magic-byte sniff) at confirm. HEAD `ContentType` (client-controlled, echoed by MinIO) is treated as untrusted and used only as a coarse pre-filter.
4. **Hard `SCANNED` gate (fail-safe-up).** `linkToMessage` refuses anything that is not `SCANNED`. `STORED` is **not** consumable. MVP ships a synchronous scan stub (`STORED→SCANNED`) so legitimate uploads pass; a real ClamAV worker drops in with zero schema/contract change.
5. **effectivePrivacy fail-safe default `INTERNAL_ONLY`.** Never `PUBLIC` by default. The router stamps the **final per-turn** effective privacy (after the G2 classifier / fail-safe-up has run) as the **last step before dispatch**, inside the routing transaction — not the raw conversation default at message-create. An un-stamped attachment is never COMMUNITY-eligible.
6. **Ownership + single-bind link.** `linkToMessage` filters by `userId` AND `chatMessageId: null` — a member cannot relink another member's (or an already-used) attachment. Sweeper skips attachments bound to a non-terminal Job. AuditLog emitted on confirm/delete/sweep.

**Prisma deltas:**
```prisma
model Attachment {
  id               String   @id @default(cuid())
  workspaceId      String
  userId           String
  objectKey        String   @unique            // ws/<wsId>/att/<id>/<sanitizedName>, final at insert
  fileName         String?                      // display only
  mime             String                       // SERVER-chosen value signed into the POST policy; authoritative
  sizeBytes        Int      @default(0)         // written at confirm from HEAD; never trusted from client
  sha256           String?                      // computed server-side at confirm
  status           AttachmentStatus @default(PENDING_UPLOAD)
  effectivePrivacy JobPrivacyLevel  @default(INTERNAL_ONLY) // DERIVED, fail-safe; stamped at link (G2). never user-set
  scanResult       Json?                        // {engine, verdict, signatures?} at SCANNED
  chatMessageId    String?
  jobId            String?
  expiresAt        DateTime?                    // set at confirm = now + INPUT_RETENTION
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  confirmedAt      DateTime?
  deletedAt        DateTime?

  workspace        Workspace    @relation(fields: [workspaceId], references: [id])
  user             User         @relation(fields: [userId], references: [id])
  chatMessage      ChatMessage? @relation(fields: [chatMessageId], references: [id])
  job              Job?         @relation(fields: [jobId], references: [id])

  @@index([workspaceId, status])
  @@index([status, expiresAt])                  // sweeper scan
  @@index([chatMessageId])
  @@index([jobId])
}

enum AttachmentStatus {
  PENDING_UPLOAD
  STORED
  SCANNED
  DELETED
}
```
Back-relations (one line each): `Workspace.attachments Attachment[]`, `User.attachments Attachment[]`, `ChatMessage.attachments Attachment[]`, `Job.attachments Attachment[]`. `JobPrivacyLevel` reused unchanged. `Job.inputObjectKey` retained (legacy single-object jobs). Migration is additive only — new table + new enum + nullable back-relations, no backfill.

**Code:**
```ts
// === storage.service.ts (S3/MinIO; S3_* env from §8) ===
import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost, PresignedPost } from '@aws-sdk/s3-presigned-post';
import { createHash } from 'crypto';
import { Readable } from 'stream';

@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);
  private readonly bucket = process.env.S3_BUCKET!;
  private readonly s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
  });

  // Presigned POST: S3/MinIO ENFORCES content-length-range AND exact content-type
  // at upload time. Closes the >cap disk-exhaustion DoS at the door.
  async presignPost(objectKey: string, mime: string, maxBytes: number, ttlSec = 300): Promise<PresignedPost> {
    return createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: objectKey,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        ['eq', '$Content-Type', mime],
      ],
      Fields: { 'Content-Type': mime },
      Expires: ttlSec,
    });
  }

  async head(objectKey: string) {
    const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    return { sizeBytes: Number(r.ContentLength ?? 0), mime: r.ContentType ?? '' };
  }

  async hashAndSniff(objectKey: string): Promise<{ sha256: string; firstBytes: Buffer }> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    const body = r.Body as Readable;
    const hash = createHash('sha256');
    let firstBytes = Buffer.alloc(0);
    for await (const chunk of body) {
      const b = Buffer.from(chunk);
      if (firstBytes.length < 4096) firstBytes = Buffer.concat([firstBytes, b]).subarray(0, 4096);
      hash.update(b);
    }
    return { sha256: hash.digest('hex'), firstBytes };
  }

  async delete(objectKey: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }
}

// === attachment.constants.ts ===
export const ATTACH_MIME_ALLOWLIST = new Set([
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv',
  'application/json', 'image/png', 'image/jpeg', 'image/webp',
]);
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACH_INPUT_RETENTION_MS =
  Number(process.env.ATTACHMENT_INPUT_RETENTION_DAYS ?? 30) * 86_400_000;

const SIG: Array<[string, (b: Buffer) => boolean]> = [
  ['application/pdf', b => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  ['image/png', b => b.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))],
  ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', b => b.subarray(0,4).toString('latin1')==='RIFF' && b.subarray(8,12).toString('latin1')==='WEBP'],
];
// Sniff against the SERVER-chosen mime. Binary types must match magic bytes.
// text/*, text/markdown, text/csv: structurally unsniffable -> require valid UTF-8.
// application/json: additionally must JSON.parse.
export function sniffOk(serverMime: string, firstBytes: Buffer): boolean {
  const rule = SIG.find(([m]) => m === serverMime);
  if (rule) return rule[1](firstBytes);
  // non-binary allowlist members
  const utf8Ok = Buffer.from(firstBytes.toString('utf8'), 'utf8').length === firstBytes.length
    || isLikelyUtf8(firstBytes);
  if (serverMime === 'application/json') {
    try { JSON.parse(firstBytes.toString('utf8')); return true; } catch { return firstBytes.length >= 4096; /* truncated head: defer to full validation in scan worker */ }
  }
  return utf8Ok;
}
function isLikelyUtf8(b: Buffer): boolean {
  try { new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, b.length - (b.length % 1))); return true; }
  catch { return false; }
}

// === attachment.service.ts ===
import {
  Injectable, BadRequestException, NotFoundException, ForbiddenException,
  PayloadTooLargeException, UnsupportedMediaTypeException, ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AttachmentStatus, JobPrivacyLevel, Prisma } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import {
  ATTACH_MIME_ALLOWLIST, ATTACH_MAX_BYTES, ATTACH_INPUT_RETENTION_MS, sniffOk,
} from './attachment.constants';

@Injectable()
export class AttachmentService {
  constructor(private prisma: PrismaService, private storage: StorageService) {}

  // STEP 1 — presign. id + objectKey computed BEFORE insert => single create, no
  // placeholder, no @unique collision under concurrency.
  async presign(ctx: { workspaceId: string; userId: string },
                dto: { mime: string; fileName?: string }) {
    if (!ATTACH_MIME_ALLOWLIST.has(dto.mime)) throw new UnsupportedMediaTypeException('mime not allowed');
    const id = createId();
    const safeName = (dto.fileName ?? 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120);
    const objectKey = `ws/${ctx.workspaceId}/att/${id}/${safeName}`;
    await this.prisma.attachment.create({
      data: {
        id, workspaceId: ctx.workspaceId, userId: ctx.userId,
        mime: dto.mime,                       // SERVER-chosen, authoritative
        fileName: dto.fileName, objectKey,
        status: AttachmentStatus.PENDING_UPLOAD,
        effectivePrivacy: JobPrivacyLevel.INTERNAL_ONLY, // fail-safe default
      },
    });
    const post = await this.storage.presignPost(objectKey, dto.mime, ATTACH_MAX_BYTES);
    // client POSTs multipart/form-data: {...post.fields, 'Content-Type': mime, file}
    return { attachmentId: id, url: post.url, fields: post.fields, objectKey };
  }

  // STEP 2 — confirm. Server is source of truth. mime validated against the
  // server-chosen value on the row, NOT against client-controlled HEAD ContentType.
  async confirm(ctx: { workspaceId: string; userId: string }, id: string) {
    const att = await this.guardOwned(ctx, id);
    if (att.status === AttachmentStatus.DELETED)
      throw new ConflictException('attachment was rejected or deleted');
    if (att.status !== AttachmentStatus.PENDING_UPLOAD) return att; // already STORED/SCANNED: idempotent
    const head = await this.storage.head(att.objectKey).catch(() => null);
    if (!head) throw new BadRequestException('object not uploaded');
    if (head.sizeBytes > ATTACH_MAX_BYTES) {           // defense in depth; POST policy already capped
      await this.hardDelete(att.id, att.objectKey, ctx.userId, 'oversize');
      throw new PayloadTooLargeException('uploaded file exceeds limit');
    }
    const { sha256, firstBytes } = await this.storage.hashAndSniff(att.objectKey);
    if (!sniffOk(att.mime, firstBytes)) {              // sniff against SERVER mime
      await this.hardDelete(att.id, att.objectKey, ctx.userId, 'content-type-mismatch');
      throw new BadRequestException('content does not match declared type');
    }
    const stored = await this.prisma.attachment.update({
      where: { id: att.id },
      data: {
        status: AttachmentStatus.STORED, sizeBytes: head.sizeBytes, sha256,
        confirmedAt: new Date(),
        expiresAt: new Date(Date.now() + ATTACH_INPUT_RETENTION_MS),
      },
    });
    await this.audit(ctx.userId, 'ATTACHMENT_CONFIRMED', att.id, { sha256, sizeBytes: head.sizeBytes });
    // scan worker promotes STORED -> SCANNED (MVP stub does it synchronously).
    return stored;
  }

  // STEP 3 — link to a chat message. Called LAST, after the G2 classifier has run,
  // inside the routing transaction. effectivePrivacy is the FINAL per-turn value.
  // Only own + unlinked + SCANNED rows may bind, exactly once.
  async linkToMessage(
    tx: Prisma.TransactionClient,
    ctx: { workspaceId: string; userId: string },
    messageId: string, attachmentIds: string[], effectivePrivacy: JobPrivacyLevel,
  ) {
    if (!attachmentIds.length) return;
    const rows = await tx.attachment.findMany({
      where: { id: { in: attachmentIds }, workspaceId: ctx.workspaceId, userId: ctx.userId },
    });
    if (rows.length !== attachmentIds.length) throw new ForbiddenException('attachment not owned');
    for (const r of rows) {
      if (r.status !== AttachmentStatus.SCANNED)            // HARD fail-safe gate
        throw new BadRequestException(`attachment ${r.id} not scanned`);
      if (r.chatMessageId && r.chatMessageId !== messageId) // single-bind
        throw new ConflictException(`attachment ${r.id} already linked`);
    }
    const res = await tx.attachment.updateMany({
      where: {
        id: { in: attachmentIds }, workspaceId: ctx.workspaceId,
        userId: ctx.userId, chatMessageId: null, status: AttachmentStatus.SCANNED,
      },
      data: { chatMessageId: messageId, effectivePrivacy }, // FINAL per-turn privacy
    });
    if (res.count !== attachmentIds.length) throw new ConflictException('attachment link race');
  }

  async linkToJob(tx: Prisma.TransactionClient, ctx: { workspaceId: string }, jobId: string, attachmentIds: string[]) {
    if (!attachmentIds.length) return;
    await tx.attachment.updateMany({
      where: { id: { in: attachmentIds }, workspaceId: ctx.workspaceId, chatMessageId: { not: null } },
      data: { jobId },
    });
  }

  async userDelete(ctx: { workspaceId: string; userId: string }, id: string) {
    const att = await this.guardOwned(ctx, id);
    await this.hardDelete(att.id, att.objectKey, ctx.userId, 'user-delete');
    return { ok: true };
  }

  private async guardOwned(ctx: { workspaceId: string; userId: string }, id: string) {
    const att = await this.prisma.attachment.findUnique({ where: { id } });
    if (!att || att.workspaceId !== ctx.workspaceId) throw new NotFoundException();
    if (att.userId !== ctx.userId) throw new ForbiddenException();
    return att;
  }

  private async hardDelete(id: string, objectKey: string, actorUserId: string, reason: string) {
    await this.storage.delete(objectKey).catch(() => undefined);
    await this.prisma.attachment.update({
      where: { id }, data: { status: AttachmentStatus.DELETED, deletedAt: new Date() },
    });
    await this.audit(actorUserId, 'ATTACHMENT_DELETED', id, { reason });
  }

  private async audit(actorUserId: string, action: string, attachmentId: string, meta: object) {
    await this.prisma.auditLog.create({
      data: { actorUserId, action, targetType: 'Attachment', targetId: attachmentId, metadata: meta as Prisma.InputJsonValue },
    }).catch(() => undefined);
  }
}

// === attachment-retention.processor.ts (BullMQ repeatable; hourly) ===
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AttachmentStatus, Prisma } from '@prisma/client';

// Job statuses that still need the input bytes present.
const ACTIVE_JOB = ['QUEUED', 'RUNNING', 'PENDING_VERIFICATION', 'OPTIMISTIC'];

@Processor('attachment-retention')
export class AttachmentRetentionProcessor extends WorkerHost {
  constructor(private prisma: PrismaService, private storage: StorageService) { super(); }
  async process() {
    // 1) expire input attachments past retention, EXCEPT those feeding an active job.
    const expired = await this.prisma.attachment.findMany({
      where: {
        status: { in: [AttachmentStatus.STORED, AttachmentStatus.SCANNED] },
        expiresAt: { lte: new Date() },
        OR: [{ jobId: null }, { job: { status: { notIn: ACTIVE_JOB as any } } }],
      },
      take: 500,
    });
    for (const a of expired) await this.purge(a.id, a.objectKey);

    // 2) GC abandoned (presigned, never confirmed) uploads older than 1h.
    const stale = await this.prisma.attachment.findMany({
      where: { status: AttachmentStatus.PENDING_UPLOAD, createdAt: { lte: new Date(Date.now() - 3_600_000) } },
      take: 500,
    });
    for (const a of stale) await this.purge(a.id, a.objectKey);
  }
  private async purge(id: string, objectKey: string) {
    await this.storage.delete(objectKey).catch(() => undefined);
    await this.prisma.attachment.update({
      where: { id }, data: { status: AttachmentStatus.DELETED, deletedAt: new Date() },
    });
    await this.prisma.auditLog.create({
      data: { actorUserId: null, action: 'ATTACHMENT_RETENTION_PURGE', targetType: 'Attachment', targetId: id, metadata: {} as Prisma.InputJsonValue },
    }).catch(() => undefined);
  }
}

// === scan worker (MVP stub; real ClamAV drops in unchanged) ===
// Picks STORED rows, runs size/mime/sha already done at confirm, sets
// scanResult={engine:'mvp-stub',verdict:'clean'} and status=SCANNED.
// linkToMessage refuses any non-SCANNED row (fail-safe-up, G2).

// === controller surface ===
// POST   /api/attachments/presign     { mime, fileName? } -> { attachmentId, url, fields, objectKey }
// POST   /api/attachments/:id/confirm  -> Attachment (STORED) | 409 if rejected/deleted
// DELETE /api/attachments/:id          -> { ok:true }
// POST /api/chat/conversations/:id/messages accepts attachments:[ids]; router runs G2
//   classifier, then in ONE tx: create message -> compute final effectivePrivacy ->
//   linkToMessage(tx,...) as the LAST step before dispatch. COMMUNITY eligibility
//   unchanged (G2 hard trust-set filter).
```

**Spec patch:**
- **§9** — add sub-section **9.2.1 Attachments**: paste the `model Attachment` + `enum AttachmentStatus` block above and the four back-relation lines. Add: "Attachments have no independent privacyLevel; `effectivePrivacy` is a DERIVED, fail-safe (`INTERNAL_ONLY`) snapshot stamped at link time with the FINAL per-turn effective privacy (after the G2 classifier), and it governs node eligibility exactly as chat plaintext does (G2). `Job.inputObjectKey` is retained for legacy single-object jobs and superseded by Attachment for chat-originated jobs."
- **§10.2** (`POST /api/chat/conversations/:id/messages`) — keep the existing field name **`attachments`** (now an array of attachment ids — **non-breaking**, no rename). Add note: "ids reference Attachment rows from the presign+confirm flow (§9.2.1); only SCANNED, own, unlinked attachments may bind; the server stamps `chatMessageId` and the final `effectivePrivacy` as the last step before dispatch." Add to the HTTP block: `POST /api/attachments/presign`, `POST /api/attachments/:id/confirm`, `DELETE /api/attachments/:id`, documenting presigned-POST request/response and confirm semantics (HEAD size, sha256, magic-byte sniff against server mime, `PENDING_UPLOAD→STORED`, set `expiresAt`).
- **§20.4** — set the bullet list to: presigned **direct-to-storage POST** with server-enforced content-length-range + content-type at upload; mime allowlist + 25 MB cap enforced at presign POST policy AND re-validated at confirm (client size/mime never trusted; server-chosen mime is authoritative); attachment content inherits the conversation effective privacy (G2), no separate axis; **not consumable until status=SCANNED** (malware gate, fail-safe-up); input attachments deleted after `ATTACHMENT_INPUT_RETENTION_DAYS` (default 30) via hourly sweeper, **except** while feeding an active job; abandoned uploads GC'd after 1h; immediate user delete; attachment lifecycle (confirm/delete/retention purge) written to AuditLog; output retention configured separately (`Job.outputObjectKey`); CreditLedger/AuditLog retained independently.
- **§8** — add `ATTACHMENT_INPUT_RETENTION_DAYS=30` under the Storage block (S3_* reused).
- **Cross-gap flag (G2):** attachment routing safety assumes the G2 conversation default (`VERIFIED_ONLY`) is applied. If `ChatConversation.privacyLevel` schema default is still `PUBLIC` (spec line ~760), reconcile with G2 — the attachment's own default is already hardened to `INTERNAL_ONLY`, so an un-stamped attachment is never COMMUNITY-eligible regardless.

**Known limitations:**
- MVP malware scan is a stub (sniff+size+sha); a real ClamAV worker is required before untrusted public uploads — `SCANNED` gate + `scanResult` field make it a zero-contract swap; until then a well-formed-but-malicious PDF/PNG can reach the (sandboxed) model only under PUBLIC+OpenTierConsent.
- `text/*`/`text/csv`/`text/markdown` are content-verified only as valid UTF-8 (not structurally); `application/json` is `JSON.parse`-checked on the 4 KB head, full parse deferred to the scan worker for truncated heads.
- sha256 streams the full object at confirm (one GET, O(filesize)) — fine on single-VPS MVP; could defer to the scan worker if confirm latency bites.
- `effectivePrivacy` is a point-in-time snapshot bound to one message; a later "retroactive privacy upgrade" of a conversation would need explicit re-evaluation (not handled in MVP).
- Retention purge removes the S3 object but keeps the row (status=DELETED) for audit; `fileName` may carry PII after content is gone — null it on purge if that matters.
- Workspace isolation is logical (objectKey prefix + DB check), not physical bucket/IAM separation — acceptable for single-VPS MVP.

---

I have enough context from the spec citations already validated in the review. Producing the final resolution.

### G8 — Pre-routing cost/heaviness estimator

**Decision:** Add a cheap, synchronous, model-free `HeavinessEstimatorService` that runs as a pre-pass before both the G2 `AiRouterService.plan()` and GRID job submission. It never tokenizes binaries or parses PDF contents — it estimates from metadata only: (1) attachment byte-sum vs `AI_GRID_FILE_THRESHOLD_MB`, (2) text-token heuristic `ceil(chars/4)` vs `AI_GRID_JOB_THRESHOLD_TOKENS`, (3) `jobType` ∈ `HEAVY_JOB_TYPES`, (4) attachment count, (5) derived `estSeconds > 15`. Output is `Estimate{ isHeavy, estInputTokens, estCredits, preAuthCredits, estSeconds, lane, reasons[] }`. Lane mapping: `isHeavy === true ⇒ GRID`, feeding G2's `grid` flag; G2 still owns privacy/trust-set/node eligibility. Advisory-**up** only: it can force GRID, never FAST. Three review-mandated corrections fold in:

1. **Credits are charged from the §15.3 flat-tier table, not an invented per-token curve.** The estimate equals what settle charges. Chat buckets by token count into `chat.fast.small`(2)/`chat.fast.medium`(5); job types use their flat §15.3 value.
2. **Pre-authorization is a real, persisted, atomic HOLD.** Because `CreditLedger` is append-only with `@@unique([jobId,reason])` and balance = `SUM(amount)`, a hold cannot live in the ledger without either colliding on the unique key or being indistinguishable from a charge. Resolution: a new `CreditHold` model. `reserve` = insert one `HELD` row inside a SERIALIZABLE txn that locks a per-user `UserBalance` materialization row and rejects if `ledgerBalance − SUM(HELD) < preAuthCredits` (closes the TOCTOU double-spend). `settle` = mark `SETTLED` + insert exactly one `CreditLedger USER_SPEND` with the **real metered** amount. Failure = mark `RELEASED`. Effective balance nets active holds.
3. **At dispatch the server recomputes `totalBytes` from server-measured upload sizes** (MinIO/S3 object size), never the client's `sizeBytes`. `POST /api/chat/estimate` is advisory-only; the authoritative estimate at dispatch is server-side.

**Prisma deltas:**
```prisma
enum CreditHoldStatus {
  HELD
  SETTLED
  RELEASED
}

// Persisted pre-authorization hold. Effective balance = ledgerBalance - SUM(amount WHERE HELD).
model CreditHold {
  id           String           @id @default(cuid())
  userId       String
  jobId        String
  amount       Int              // preAuthCredits reserved
  status       CreditHoldStatus @default(HELD)
  createdAt    DateTime         @default(now())
  settledAt    DateTime?
  releasedAt   DateTime?

  user User @relation(fields: [userId], references: [id])

  @@unique([jobId])              // one live hold per job; idempotent reserve
  @@index([userId, status])      // fast SUM(HELD) per user
}

// Per-user balance materialization row. Sole lock target for atomic reserve (SELECT ... FOR UPDATE).
// ledgerBalance is the cached SUM(CreditLedger.amount); recomputed/incremented on each ledger append.
model UserBalance {
  userId        String   @id
  ledgerBalance Int      @default(0)
  updatedAt     DateTime @updatedAt

  user User @relation(fields: [userId], references: [id])
}
```
Add the back-relations on `User`: `creditHolds CreditHold[]` and `balance UserBalance?`. No enum change to `CreditLedgerReason` — the hold lives in `CreditHold`, so the existing `USER_SPEND` (one per job) is untouched and `@@unique([jobId,reason])` is never violated. `HEAVY_JOB_TYPES` stays a code-level Set keyed off the G4 `JOB_TYPES` registry, not a DB enum.

**Code:**
```ts
// estimator/heaviness-estimator.service.ts
// G8 — cheap pre-routing estimator. No model run, no tokenizer, no PDF parse.
import { Injectable } from '@nestjs/common';

export type Lane = 'FAST' | 'GRID' | 'FALLBACK';
export type EstReason =
  | 'MODE_GRID_FORCED'
  | 'FILE_OVER_THRESHOLD'
  | 'TOKENS_OVER_THRESHOLD'
  | 'SECONDS_OVER_THRESHOLD'
  | 'JOBTYPE_HEAVY_SET'
  | 'MANY_ATTACHMENTS'
  | 'LIGHT';

export interface EstimatorAttachment { sizeBytes: number; mime?: string } // metadata only
export interface EstimatorInput {
  mode?: 'AUTO' | 'FAST' | 'GRID';
  text?: string;           // chat prompt OR job text payload (may be empty for binary jobs)
  jobType?: string;        // e.g. 'embedding.v1'; undefined for plain chat
  attachments?: EstimatorAttachment[];
  preferredModel?: string; // 'auto' | concrete model id
}
export interface Estimate {
  isHeavy: boolean;
  estInputTokens: number;
  estCredits: number;      // expected metered cost, from §15.3 flat tiers
  preAuthCredits: number;  // amount to HOLD before dispatch (>= estCredits)
  estSeconds: number;
  lane: Lane;              // FAST | GRID (FALLBACK decided downstream by G2)
  reasons: EstReason[];
}

// Heavy members of the G4 JOB_TYPES registry (registry remains single source of truth).
const HEAVY_JOB_TYPES = new Set<string>([
  'embedding.v1', 'transcription.v1', 'ocr.v1', 'image.v1',
]);

// §15.3 FLAT credit tiers — the single source of truth for both quote and settle.
// estCredits MUST equal the value the billing path charges; no per-token curve invented here.
const CHAT_SMALL_MAX_TOKENS = 2000;                 // <= => chat.fast.small, else chat.fast.medium
const CHAT_FAST_SMALL = 2;
const CHAT_FAST_MEDIUM = 5;
const JOB_FLAT_CREDITS: Record<string, number> = {  // §15.3 spend defaults
  'echo.v1': 1,
  'embedding.v1': 5,
  'transcription.v1': 20,
  'ocr.v1': 15,
  'image.v1': 25,
};

// Rough wall-clock anchors — used ONLY for the >15s GRID trigger and a UX seconds quote.
const SECS_TABLE: Record<string, { baseSecs: number; secsPerKTok: number }> = {
  'chat':             { baseSecs: 2,  secsPerKTok: 1.5 },
  'echo.v1':          { baseSecs: 1,  secsPerKTok: 0   },
  'embedding.v1':     { baseSecs: 4,  secsPerKTok: 1.2 },
  'transcription.v1': { baseSecs: 30, secsPerKTok: 0   },
  'ocr.v1':           { baseSecs: 20, secsPerKTok: 0   },
  'image.v1':         { baseSecs: 25, secsPerKTok: 0   },
};
const DEFAULT_SECS = SECS_TABLE['chat'];

const PREAUTH_SAFETY = 1.25;
const PREAUTH_MAX_CREDITS = 500;
const HEAVY_SECONDS = 15;   // §11.2: expected execution > 15s => GRID
const MANY_ATTACH = 5;

@Injectable()
export class HeavinessEstimatorService {
  private readonly fileThresholdBytes =
    Number(process.env.AI_GRID_FILE_THRESHOLD_MB ?? 5) * 1024 * 1024;
  private readonly tokenThreshold =
    Number(process.env.AI_GRID_JOB_THRESHOLD_TOKENS ?? 6000);

  estimate(req: EstimatorInput): Estimate {
    const reasons: EstReason[] = [];
    const attachments = req.attachments ?? [];
    // safe 64-bit-correct byte sum (no bitwise |0 truncation at >2.1GB).
    const totalBytes = attachments.reduce(
      (s, a) => s + Math.max(0, Math.floor(Number(a.sizeBytes) || 0)), 0);

    const chars = (req.text ?? '').length;
    const estInputTokens = Math.ceil(chars / 4); // chars/4 heuristic, fail-safe-up only

    // ---- heaviness signals (any => GRID; advisory-UP only) ----
    let isHeavy = false;
    if (req.mode === 'GRID') { isHeavy = true; reasons.push('MODE_GRID_FORCED'); }
    if (totalBytes > this.fileThresholdBytes) { isHeavy = true; reasons.push('FILE_OVER_THRESHOLD'); }
    if (estInputTokens > this.tokenThreshold) { isHeavy = true; reasons.push('TOKENS_OVER_THRESHOLD'); }
    if (req.jobType && HEAVY_JOB_TYPES.has(req.jobType)) { isHeavy = true; reasons.push('JOBTYPE_HEAVY_SET'); }
    if (attachments.length >= MANY_ATTACH) { isHeavy = true; reasons.push('MANY_ATTACHMENTS'); }

    // ---- estCredits strictly from §15.3 flat tiers (matches settle) ----
    let estCredits: number;
    if (req.jobType && JOB_FLAT_CREDITS[req.jobType] !== undefined) {
      estCredits = JOB_FLAT_CREDITS[req.jobType];
    } else {
      estCredits = estInputTokens <= CHAT_SMALL_MAX_TOKENS ? CHAT_FAST_SMALL : CHAT_FAST_MEDIUM;
    }

    // ---- estSeconds (UX quote + >15s GRID trigger only) ----
    const secsAnchor = (req.jobType && SECS_TABLE[req.jobType]) || DEFAULT_SECS;
    const kTok = estInputTokens / 1000;
    const estSeconds = Math.ceil(
      secsAnchor.baseSecs + secsAnchor.secsPerKTok * kTok +
      (totalBytes / this.fileThresholdBytes) * 5);
    if (estSeconds > HEAVY_SECONDS && !isHeavy) { isHeavy = true; reasons.push('SECONDS_OVER_THRESHOLD'); }

    if (reasons.length === 0) reasons.push('LIGHT');

    const lane: Lane = isHeavy ? 'GRID' : 'FAST';
    const preAuthCredits = Math.min(PREAUTH_MAX_CREDITS, Math.ceil(estCredits * PREAUTH_SAFETY));
    return { isHeavy, estInputTokens, estCredits, preAuthCredits, estSeconds, lane, reasons };
  }
}
```
```ts
// credits/credit-hold.service.ts — atomic reserve / settle / release.
import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CreditHoldService {
  constructor(private readonly prisma: PrismaService) {}

  // Reserve preAuthCredits atomically. Throws if effective balance is insufficient.
  // SERIALIZABLE + row-lock on UserBalance closes the read-then-insert TOCTOU race.
  async reserve(userId: string, jobId: string, preAuthCredits: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // lock the per-user balance row (materialized SUM of ledger).
      const bal = await tx.$queryRaw<Array<{ ledgerBalance: number }>>`
        SELECT "ledgerBalance" FROM "UserBalance" WHERE "userId" = ${userId} FOR UPDATE`;
      const ledgerBalance = bal[0]?.ledgerBalance ?? 0;

      const held = await tx.creditHold.aggregate({
        where: { userId, status: 'HELD' },
        _sum: { amount: true },
      });
      const effective = ledgerBalance - (held._sum.amount ?? 0);
      if (effective < preAuthCredits) {
        throw new ForbiddenException('INSUFFICIENT_CREDITS'); // fail closed before any compute
      }
      // @@unique([jobId]) makes reserve idempotent on retry.
      await tx.creditHold.create({
        data: { userId, jobId, amount: preAuthCredits, status: 'HELD' },
      });
    }, { isolationLevel: 'Serializable' });
  }

  // At settle: charge the REAL metered cost (one USER_SPEND row), close the hold.
  async settle(userId: string, jobId: string, realMeteredCredits: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.creditHold.update({
        where: { jobId },
        data: { status: 'SETTLED', settledAt: new Date() },
      });
      await tx.creditLedger.create({                       // exactly one USER_SPEND per job
        data: { userId, jobId, reason: 'USER_SPEND', amount: -realMeteredCredits },
      });
      await tx.userBalance.update({
        where: { userId },
        data: { ledgerBalance: { decrement: realMeteredCredits } },
      });
    });
  }

  async release(jobId: string): Promise<void> {
    await this.prisma.creditHold.update({
      where: { jobId },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
  }
}
```
```ts
// estimator/chat-estimate.controller.ts — POST /api/chat/estimate (spec §10.2 L943). Advisory-only.
import { Body, Controller, Post } from '@nestjs/common';
@Controller('api/chat')
export class ChatEstimateController {
  constructor(private readonly estimator: HeavinessEstimatorService) {}
  @Post('estimate')
  estimate(@Body() body: EstimatorInput): Estimate {
    // pure metadata in, Estimate out. No model call, no hold, no side effects.
    // attachments[].sizeBytes here is a client hint for a NON-binding quote only.
    return this.estimator.estimate(body);
  }
}

// ---- dispatch wiring (authoritative; NOT the advisory endpoint) ----
//   // recompute attachment sizes from server-measured S3/MinIO object sizes — never the client number:
//   const serverAttachments = await this.storage.statAll(attachmentIds);
//   const est = this.estimator.estimate({ mode: req.mode, text: req.message,
//                 jobType: req.jobType, attachments: serverAttachments, preferredModel: req.preferredModel });
//   await this.creditHold.reserve(userId, jobId, est.preAuthCredits); // throws => reject pre-compute
//   const plan = await this.aiRouter.plan({ ...g2Input, grid: est.lane === 'GRID' });
//   // ... on success: await this.creditHold.settle(userId, jobId, realMeteredCredits);
//   // ... on failure: await this.creditHold.release(jobId);
```

**Spec patch:**
- **§11.3 (Pseudocode, L1199–1225):** replace the dangling `estimator.estimate(req)` with: *"estimator.estimate(req) is a cheap, synchronous, model-free pre-pass returning `Estimate{ isHeavy, estInputTokens, estCredits, preAuthCredits, estSeconds, lane, reasons[] }`. isHeavy is true if ANY of: mode===GRID; server-measured Σ(attachment bytes) > AI_GRID_FILE_THRESHOLD_MB; ceil(chars/4) > AI_GRID_JOB_THRESHOLD_TOKENS; jobType ∈ HEAVY_JOB_TYPES; attachments ≥ 5; estSeconds > 15. isHeavy ⇒ lane GRID. Advisory-up only (can force GRID, never FAST). estCredits is taken from the §15.3 flat tiers and equals the settle charge basis. Never tokenizes binaries or parses PDFs."* Document that `estimate.isHeavy` / `estimate.preferredModel` are `Estimate` fields, and that `preAuthCredits` is held before dispatch with the real metered cost charged at settle.
- **§11.2 (Lane selection, L1182–1189):** append: *"These GRID triggers are computed by the G8 estimator (§11.3 / POST /api/chat/estimate), not by running the model."*
- **§10.2 (Chat AI, ~L943, after L957):** add request/response schema. Request `{ "message":"...", "mode":"AUTO", "jobType":"embedding.v1", "attachments":[{"sizeBytes":4194304,"mime":"application/pdf"}], "preferredModel":"auto" }`. Response `{ "isHeavy":true, "lane":"GRID", "estInputTokens":1875, "estCredits":5, "preAuthCredits":7, "estSeconds":18, "reasons":["FILE_OVER_THRESHOLD","JOBTYPE_HEAVY_SET"] }`. Note: *"POST /api/chat/estimate is advisory-only and reads no file bytes; attachments[].sizeBytes is a non-binding client hint. The authoritative estimate at dispatch recomputes byte totals from server-measured S3/MinIO object sizes."*
- **§15.3 (Credit rules):** note that the estimator's `estCredits` is derived strictly from this table (chat buckets: ≤2000 tok ⇒ `chat.fast.small`=2, else `chat.fast.medium`=5; job types use their flat value) so quote == settle.
- **§15.6 (new — "Pre-authorization holds"):** *"Before dispatch the server reserves `ceil(estCredits×1.25)` (cap 500) as a `CreditHold` row (status HELD). The reserve runs in a SERIALIZABLE transaction that locks the per-user `UserBalance` row and rejects when `ledgerBalance − Σ(HELD) < hold`, so concurrent heavy requests cannot double-spend. Effective balance = ledger SUM minus active HELD holds. At settle the hold is marked SETTLED and exactly one `CreditLedger USER_SPEND` row is appended with the real metered cost (the §9.4 `@@unique([jobId,reason])` invariant is preserved — one USER_SPEND per job). On dispatch failure the hold is marked RELEASED. The hold is an estimate and is never itself the charge."*
- **§9.4 / data model:** add `CreditHold`, `CreditHoldStatus`, and `UserBalance` (materialized ledger SUM, sole lock target for atomic reserve).
- **§19/env table:** document `AI_GRID_JOB_THRESHOLD_TOKENS` and `AI_GRID_FILE_THRESHOLD_MB` as the estimator's two thresholds (already in .env L518–519).

**Known limitations:** (medium) `estSeconds` for binary jobs (ocr/transcription/image) is byte-size-guessed and can be off 2–3× — a UX quote only; the GRID lane decision is correct regardless. (low) `chars/4` underestimates CJK/code-heavy prompts, but only ever misroutes toward GRID (fail-safe-up); revisit with a per-script divisor post-MVP. (low) thresholds are env-global, not per-model — fine for single-VPS MVP, needs per-model thresholds at scale. (low) `PREAUTH_MAX_CREDITS=500` can under-hold a genuinely huge legitimate job by design; the G1 verification flow still gates NRN payout, so platform exposure is bounded — only the user's hold is capped.

Relevant file: `C:\Users\Giacomo\Desktop\Jitengineering\Projects\Neurion\NEURION_SPEC_Codex_IT_EN_v1.1.md`.

---

I have the full G9 context and review findings. Let me produce the final authoritative resolution, folding in the corrections (false validation rationale, onDelete semantics) and keeping the low-severity items as known limitations.

### G9 — ChatMessage.linkedJobId relation

**Decision:** Add an explicit named Prisma relation `linkedJob`/`linkedFromMessages` between `ChatMessage.linkedJobId` and `Job`. Keep `linkedJobId` nullable (backward-compatible; no value migration). Name the relation explicitly (`"ChatMessageLinkedJob"`) **proactively** — not because validation currently fails. Today `Job.chatMessageId` is a bare `String?` scalar with no `@relation`, so there is only one Job↔ChatMessage relation and Prisma auto-disambiguates; `prisma validate` passes without a name. The explicit name reserves disambiguation for when `Job.chatMessageId` is eventually wired as a real inverse relation, avoiding a future breaking rename. Set `onDelete: Restrict` so a Job referenced by chat history cannot be silently hard-deleted (the optional-relation default of `SetNull` would silently corrupt conversation history). Index `linkedJobId` (non-unique — one Job legitimately maps to many messages, e.g. "queued" + "completed" cards). Do NOT wire `Job.chatMessageId` in this gap; out of scope.

**Prisma deltas:**
```prisma
// ── model ChatMessage (§9.3): add relation field + index ──
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
  costCredits     Int      @default(0)
  linkedJobId     String?
  createdAt       DateTime @default(now())

  conversation    ChatConversation @relation(fields: [conversationId], references: [id])
  linkedJob       Job? @relation("ChatMessageLinkedJob", fields: [linkedJobId], references: [id], onDelete: Restrict)

  @@index([linkedJobId])
}

// ── model Job (§9.2): add back-relation only (no new scalar/FK) ──
// Job.chatMessageId stays a bare String? scalar — out of scope for G9.
// Add inside Job's relations block:
//
//   workspace          Workspace    @relation(fields: [workspaceId], references: [id])
//   user               User         @relation(fields: [userId], references: [id])
//   node               ComputeNode? @relation(fields: [nodeId], references: [id])
//   events             JobEvent[]
   linkedFromMessages ChatMessage[] @relation("ChatMessageLinkedJob")
```

**Code:**
```ts
// Relation enables a single-query job card — no manual second findUnique.
const message = await this.prisma.chatMessage.findUnique({
  where: { id: messageId },
  include: {
    linkedJob: {
      select: {
        id: true,
        type: true,
        status: true,
        lane: true,
        verificationScore: true,
        completedAt: true,
        verifiedAt: true,
        errorMessage: true,
        outputObjectKey: true, // server-side only — presign/resolve before returning to client
      },
    },
  },
});
// message.linkedJob is Job | null — render the card directly.

// Conversation history with job cards in one query:
const messages = await this.prisma.chatMessage.findMany({
  where: { conversationId },
  orderBy: { createdAt: 'asc' },
  include: {
    linkedJob: { select: { id: true, status: true, lane: true, verificationScore: true } },
  },
});
// Authz unchanged: caller must still scope by workspaceId/userId; the include is
// read-only convenience and does NOT widen the existing authorization boundary.
```

**Spec patch:**
- **§9.2 (model Job):** inside the relations block, after `events JobEvent[]`, add `linkedFromMessages ChatMessage[] @relation("ChatMessageLinkedJob")`. No scalar change; `Job.chatMessageId` stays a bare `String?`, explicitly out of scope for G9.
- **§9.3 (model ChatMessage):** keep `linkedJobId String?` unchanged; after the `conversation` relation add `linkedJob Job? @relation("ChatMessageLinkedJob", fields: [linkedJobId], references: [id], onDelete: Restrict)` and add `@@index([linkedJobId])` (non-unique).
- **§9.3 prose:** add: "`ChatMessage.linkedJobId` is a nullable FK to `Job` via the named relation `ChatMessageLinkedJob`, with `onDelete: Restrict` so jobs referenced by chat history cannot be hard-deleted. It is distinct from `Job.chatMessageId` (the message that spawned the job), which currently remains an unwired scalar pointer. The relation is named explicitly to reserve disambiguation for the future wiring of that inverse axis — not because validation currently requires it (with only one real relation today, Prisma auto-disambiguates). The `linkedJob` include is read-only convenience and does not alter the existing authz boundary; the chat service must continue to scope by workspaceId/userId and must never return `outputObjectKey` as a raw S3 key (presign/resolve server-side)."
- Bump the §1/changelog schema-revision note if tracked.

**Known limitations:**
- Pre-migration: the new FK will fail if orphaned `linkedJobId` values exist — run `SELECT count(*) FROM "ChatMessage" m LEFT JOIN "Job" j ON m."linkedJobId"=j.id WHERE m."linkedJobId" IS NOT NULL AND j.id IS NULL` and null-out orphans before applying.
- `onDelete: Restrict` means any future job-deletion flow must first detach referencing messages; acceptable since jobs are not hard-deleted today.
- `@@index([linkedJobId])` is deliberately non-unique (one job → many messages); `@@unique` would be a bug.
- The reserved name `"ChatMessageLinkedJob"` must not be reused when `Job.chatMessageId` is later wired — that inverse pointer needs its own distinct relation name.
- `linkedJob` include exposes `outputObjectKey`/`verificationScore`; authorization scoping and S3-key presigning remain the caller's responsibility (unchanged by this schema delta).

---

### G10 — Cost reconciliation: estimate vs actual

**Decision:**

The `/estimate` value is DISPLAY-ONLY; it never debits the user. Money moves in two real ledger phases against the append-only `CreditLedger` (balance = SUM(amount)):

1. **HOLD (pre-authorization)** at submit time: reserve `ceil(estimate * ceiling)` via a negative `USER_SPEND_HOLD` ledger row + a `CreditHold` lifecycle row. The hold immediately reduces spendable balance, guaranteeing funds. Insufficient balance ⇒ `402 {code:"PAYMENT_REQUIRED"}` before any provider/node work. The hold tx takes a **per-user advisory lock** so concurrent holds cannot both pass a stale SUM check.

2. **SETTLE on real usage** — chat: SSE `final` token usage; grid: `job.costCredits` on transition to VERIFIED (or COMPLETED for non-verified types). Settlement releases the full hold (`USER_SPEND_HOLD_RELEASE`, +) then books the real charge (`USER_SPEND`, −); net = `−actualCost`. `actualCost==0` (fail/cancel) ⇒ release only = full refund. **Failure/cancel/expiry** ⇒ `release()` = settle with 0.

Settlement is **fail-closed against reaper races**: if a long-running job's hold was already force-released by the reaper (`RELEASED`/`EXPIRED`), settle still books the real `USER_SPEND` (idempotency-guarded), so completed work is never un-charged. Already-`SETTLED` ⇒ no-op. Grid `USER_SPEND` is written **only** by G10's settle (single writer; G1's direct job USER_SPEND is superseded and removed). actualCost overage is charged up to `SETTLE_OVERAGE_CAP` (2×), then clamped + audited.

**Prisma deltas:**

```prisma
model CreditHold {
  id              String   @id @default(cuid())
  userId          String
  chatMessageId   String?  @unique          // exactly one of these set
  jobId           String?  @unique
  estimateCredits Int                        // display-only estimate at hold time
  holdCredits     Int                        // reserved = ceil(estimate * ceiling)
  actualCredits   Int?                       // filled at settle
  status          CreditHoldStatus @default(HELD)
  expiresAt       DateTime                   // reaper force-releases after this
  settledAt       DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user            User @relation(fields: [userId], references: [id])

  @@index([status, expiresAt])
  @@index([userId])
}

enum CreditHoldStatus {
  HELD        // funds reserved, work in flight
  SETTLED     // released + actual charged
  RELEASED    // released only (failure/cancel), full refund
  EXPIRED     // released by reaper (stranded), full refund — distinct for reporting
}

model CreditLedger {
  id            String   @id @default(cuid())
  userId        String
  reason        String
  amount        Int
  balanceAfter  Int
  jobId         String?
  chatMessageId String?
  holdId        String?                       // NEW: links HOLD/RELEASE/SPEND rows to CreditHold
  createdAt     DateTime @default(now())

  user          User @relation(fields: [userId], references: [id])

  @@unique([jobId, reason])                   // existing (G1)
  @@unique([holdId, reason])                  // NEW: ≤1 HOLD / 1 RELEASE / 1 SPEND per hold
  @@index([userId, createdAt])
}

model User {
  // ...existing...
  creditHolds   CreditHold[]
}
```
Additive only (new table, new enum, new nullable column + uniques, new back-relation). Postgres treats NULL as distinct, so `holdId=NULL` rows are unaffected by `@@unique([holdId,reason])`. `CreditLedger.reason` stays `String`; reasons are a TS enum (below), no DB enum migration. A job-linked settle row carries both `jobId` and `holdId` ⇒ covered by both uniques — intended and harmless (each still ≤1 USER_SPEND per job and per hold).

**Code:**

```ts
// ---- credit-ledger.reasons.ts ----
export const CreditLedgerReason = {
  USER_SPEND: 'USER_SPEND',                            // final actual charge (−)
  USER_REFUND: 'USER_REFUND',                          // post-settlement reversal / support credit (+)
  NODE_REWARD: 'NODE_REWARD',                          // node reward, post-VERIFIED (+)
  NODE_REWARD_CLAWBACK: 'NODE_REWARD_CLAWBACK',        // reward reversal on deep-verify FAIL (−)
  USER_SPEND_HOLD: 'USER_SPEND_HOLD',                  // pre-auth reserve of estimate (−)
  USER_SPEND_HOLD_RELEASE: 'USER_SPEND_HOLD_RELEASE',  // reverses a HOLD (+)
  // NOTE: USER_SPEND_SETTLE is intentionally NOT introduced.
} as const;
export type CreditLedgerReason = typeof CreditLedgerReason[keyof typeof CreditLedgerReason];

// ---- credit-hold.service.ts ----
import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreditLedgerReason } from './credit-ledger.reasons';
import { CreditHoldStatus, Prisma } from '@prisma/client';

const HOLD_TTL_MS = Number(process.env.CREDIT_HOLD_TTL_MS ?? 15 * 60 * 1000);
const CHAT_HOLD_CEILING = Number(process.env.CREDIT_HOLD_CEILING_CHAT ?? 1.0);
const SETTLE_OVERAGE_CAP = Number(process.env.CREDIT_SETTLE_OVERAGE_CAP ?? 2.0);

export class InsufficientBalanceError extends BadRequestException {
  constructor(public readonly required: number, public readonly available: number) {
    super({ code: 'PAYMENT_REQUIRED', required, available });
  }
}

type HoldLink = { chatMessageId?: string; jobId?: string };

@Injectable()
export class CreditHoldService {
  constructor(private readonly prisma: PrismaService) {}

  // Balance derived from append-only ledger (spec §15.2). Summed inside the tx.
  private async balance(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    const agg = await tx.creditLedger.aggregate({ where: { userId }, _sum: { amount: true } });
    return agg._sum.amount ?? 0;
  }

  /**
   * Pre-authorize. Throws InsufficientBalanceError (=>402). Idempotent on the link.
   * Per-user advisory lock prevents concurrent holds from both passing a stale SUM.
   */
  async hold(userId: string, estimateCredits: number, link: HoldLink, ceiling = CHAT_HOLD_CEILING) {
    if (!link.chatMessageId && !link.jobId) {
      throw new BadRequestException('hold must be linked to a chatMessage or job');
    }
    const holdCredits = Math.ceil(estimateCredits * ceiling);
    return this.prisma.$transaction(async (tx) => {
      // serialize all credit mutations for this user within the tx
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

      // explicit, non-racy idempotency lookup
      const existing = link.chatMessageId
        ? await tx.creditHold.findUnique({ where: { chatMessageId: link.chatMessageId } })
        : await tx.creditHold.findUnique({ where: { jobId: link.jobId! } });
      if (existing) return existing;

      const bal = await this.balance(tx, userId);
      if (bal < holdCredits) throw new InsufficientBalanceError(holdCredits, bal);

      let hold;
      try {
        hold = await tx.creditHold.create({
          data: {
            userId,
            chatMessageId: link.chatMessageId,
            jobId: link.jobId,
            estimateCredits,
            holdCredits,
            status: CreditHoldStatus.HELD,
            expiresAt: new Date(Date.now() + HOLD_TTL_MS),
          },
        });
      } catch (e) {
        // P2002: lost the create race despite the lock (cross-tx) — re-read and return
        if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
          return link.chatMessageId
            ? await tx.creditHold.findUniqueOrThrow({ where: { chatMessageId: link.chatMessageId } })
            : await tx.creditHold.findUniqueOrThrow({ where: { jobId: link.jobId! } });
        }
        throw e;
      }

      await tx.creditLedger.create({
        data: {
          userId, reason: CreditLedgerReason.USER_SPEND_HOLD,
          amount: -holdCredits, balanceAfter: bal - holdCredits,
          holdId: hold.id, chatMessageId: link.chatMessageId, jobId: link.jobId,
        },
      });
      return hold;
    });
  }

  /**
   * Settle on REAL usage. Fail-closed against reaper races:
   *  - HELD            => release(+hold) then USER_SPEND(-actual); net = -actual
   *  - RELEASED/EXPIRED (reaper already refunded) => book ONLY USER_SPEND(-actual)
   *  - SETTLED         => no-op
   * actualCredits==0 from a HELD hold => RELEASED (full refund).
   * Idempotent & double-charge-proof via @@unique([holdId, reason]).
   */
  async settle(holdId: string, actualCredits: number) {
    return this.prisma.$transaction(async (tx) => {
      const hold = await tx.creditHold.findUnique({ where: { id: holdId } });
      if (!hold) throw new BadRequestException('hold not found');
      if (hold.status === CreditHoldStatus.SETTLED) return hold; // already charged

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${hold.userId}))`;

      const link = { chatMessageId: hold.chatMessageId ?? undefined, jobId: hold.jobId ?? undefined };
      const cap = Math.ceil(hold.holdCredits * SETTLE_OVERAGE_CAP);
      let charge = Math.max(0, Math.round(actualCredits));
      const overCap = charge > cap;
      if (overCap) charge = cap;

      let bal = await this.balance(tx, hold.userId);

      // 1) release the hold only if it is still HELD (reaper path already released)
      if (hold.status === CreditHoldStatus.HELD) {
        bal += hold.holdCredits;
        await tx.creditLedger.create({
          data: {
            userId: hold.userId, reason: CreditLedgerReason.USER_SPEND_HOLD_RELEASE,
            amount: hold.holdCredits, balanceAfter: bal, holdId, ...link,
          },
        });
      }

      // 2) book the actual charge (idempotent via @@unique([holdId, USER_SPEND]))
      if (charge > 0) {
        bal -= charge;
        await tx.creditLedger.create({
          data: {
            userId: hold.userId, reason: CreditLedgerReason.USER_SPEND,
            amount: -charge, balanceAfter: bal, holdId, ...link,
          },
        });
      }

      const finalStatus = charge > 0 ? CreditHoldStatus.SETTLED : CreditHoldStatus.RELEASED;
      const settled = await tx.creditHold.update({
        where: { id: holdId },
        data: { actualCredits: charge, status: finalStatus, settledAt: new Date() },
      });

      if (overCap) {
        await tx.auditLog.create({
          data: {
            actorUserId: null,                       // SYSTEM action: platform capped it
            action: 'credit.settle.overage_capped',
            entityType: 'CreditHold', entityId: holdId,
            data: { requested: actualCredits, cappedTo: charge, holdCredits: hold.holdCredits },
          },
        });
      }
      return settled;
    });
  }

  /** Failure / cancel === settle with zero actual usage => full refund. */
  async release(holdId: string) {
    return this.settle(holdId, 0);
  }

  /** Reaper (BullMQ repeatable ~60s): force-release stranded holds as EXPIRED. */
  async sweepExpired(now = new Date()) {
    const stuck = await this.prisma.creditHold.findMany({
      where: { status: CreditHoldStatus.HELD, expiresAt: { lt: now } },
      select: { id: true, userId: true, holdCredits: true,
                chatMessageId: true, jobId: true }, take: 200,
    });
    for (const h of stuck) {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${h.userId}))`;
        const cur = await tx.creditHold.findUnique({ where: { id: h.id } });
        if (!cur || cur.status !== CreditHoldStatus.HELD) return; // raced with settle
        const bal = (await this.balance(tx, h.userId)) + h.holdCredits;
        await tx.creditLedger.create({
          data: {
            userId: h.userId, reason: CreditLedgerReason.USER_SPEND_HOLD_RELEASE,
            amount: h.holdCredits, balanceAfter: bal, holdId: h.id,
            chatMessageId: h.chatMessageId ?? undefined, jobId: h.jobId ?? undefined,
          },
        });
        await tx.creditHold.update({
          where: { id: h.id },
          data: { status: CreditHoldStatus.EXPIRED, settledAt: new Date() },
        });
      }).catch(() => undefined); // idempotent; swallow races
    }
    return stuck.length;
  }
}

// ---- wiring (chat) ----
// Create the assistant ChatMessage placeholder FIRST (real chatMessageId), THEN:
//   const hold = await creditHold.hold(userId, estimate.costCredits, { chatMessageId }, CHAT_HOLD_CEILING);
// on SSE `final` (real token usage -> actualCost via pricing §15.3):
//   await creditHold.settle(hold.id, actualCost);
// on stream abort / provider error (try/finally):
//   await creditHold.release(hold.id);

// ---- wiring (grid) — G10 is the SINGLE writer of job USER_SPEND ----
// at job create: const hold = await creditHold.hold(userId, estimate.costCredits, { jobId });
// on job -> VERIFIED (or COMPLETED for non-verified types): settle(hold.id, job.costCredits);
// on job -> FAILED/CANCELLED: release(hold.id);
```

**Spec patch:**

- **§10.2 (Chat AI)** — add subsection *Cost reconciliation*: `/api/chat/estimate` is display-only and never charges. The assistant `ChatMessage` placeholder row is created **before** the hold so `chatMessageId` is real. On `/api/chat/stream`, after routing and before the first provider token, place a **HOLD** = `ceil(estimate.costCredits * CREDIT_HOLD_CEILING_CHAT)` (`USER_SPEND_HOLD` − plus a `CreditHold`). Insufficient balance ⇒ `402 {code:"PAYMENT_REQUIRED", required, available}`, no provider work. The SSE `final` event now carries actual usage and is authoritative — front-end must reconcile its optimistic estimate to this number:
  ```txt
  event: final
  data: {"messageId":"msg_123","costCredits":2,"estimateCredits":2,"firstTokenMs":820,"settled":true}
  ```
  On `final` the platform **SETTLES** (release hold + book real `USER_SPEND`; net `−actualCost`). Abort/error/cancel ⇒ **RELEASE** (full refund). Settlement is idempotent (`@@unique([holdId,reason])`) and **fail-closed**: a reaper-expired hold that later completes still books `USER_SPEND`. Overage charged up to `CREDIT_SETTLE_OVERAGE_CAP` (2×), then clamped + `AuditLog action=credit.settle.overage_capped`.
- **§11 (Grid jobs)** — same HOLD-at-create / SETTLE-on-VERIFIED(or COMPLETED) / RELEASE-on-FAILED|CANCELLED lifecycle; grid `actualCost = job.costCredits`. **G10's settle is the single writer of job `USER_SPEND`; G1's direct job USER_SPEND debit is removed/superseded.** Keep `CREDIT_HOLD_TTL_MS` safely above max job+verify latency.
- **§15.6 Ledger reasons:**
  ```txt
  USER_SPEND               final actual charge (−)
  USER_REFUND              post-settlement reversal / support credit (+)
  USER_SPEND_HOLD          pre-authorization reserve of the estimate (−)
  USER_SPEND_HOLD_RELEASE  reverses a HOLD on settle/cancel/expiry (+)
  NODE_REWARD              node reward, post-VERIFIED (+)
  NODE_REWARD_CLAWBACK     reward reversal on deep-verify FAIL (−)
  # USER_SPEND_SETTLE is intentionally NOT introduced; settlement = RELEASE(+) then USER_SPEND(−).
  ```
- **§15.7 Config:**
  ```txt
  CREDIT_HOLD_TTL_MS=900000          # reaper force-release (EXPIRED) after 15m — keep > max job+verify latency
  CREDIT_HOLD_CEILING_CHAT=1.0       # hold = ceil(estimate * ceiling)
  CREDIT_SETTLE_OVERAGE_CAP=2.0      # max actual charge as multiple of hold
  ```
- **§9.4 (schema):** add `CreditHold` model + `CreditHoldStatus` enum (incl. `EXPIRED`); add `holdId String?` + `@@unique([holdId,reason])` to `CreditLedger`; add `creditHolds CreditHold[]` to `User`.

**Known limitations:**

1. Derived balance is O(ledger rows); needs a periodic materialized balance checkpoint at scale (out of scope).
2. Advisory lock serializes per-user credit mutations — fine on single-VPS; revisit for multi-region (lock is per-DB).
3. Overage cap (2×) is a policy guess; generations legitimately beyond 2× are undercharged (clamped + audited) — tune ceiling/cap with telemetry.
4. `chatMessageId`/`jobId` on `CreditHold`/`CreditLedger` are scalar (no FK in current spec schema); placeholder-message-first ordering keeps the link valid — add real FKs later if desired.
5. `EXPIRED` vs `RELEASED` distinction is reporting-only (both full refunds); a reaper-expired-then-completed hold ends `SETTLED` with the real charge, so the EXPIRED state is transient in that path.

---

### G11 — WebSocket/SSE bridge horizontal scaling

**Decision:** Adopt a thin `EventBus` + `NodeConnectionRegistry` seam now; ship the single-process in-memory implementation for MVP; keep a Redis pub/sub adapter as a drop-in DI swap (`EVENTBUS_DRIVER=redis`) behind the same interfaces. No chat/router/gateway code may reference a concrete transport — only the two interfaces. Invariant: **one node = one outbound WebSocket = one owning API instance**; the registry makes that ownership location-transparent.

MVP stays single-process: one NestJS instance holds every node WS and every browser SSE stream. Default bindings are `InProcessEventBus` (local EventEmitter) and `InProcessNodeRegistry` (`Set<nodeId>`). The scale path solves only the routing problem — a `realtime.chat.request` may arrive on the instance serving the browser SSE (B) while the target node's WS is held by another instance (A) — via three pieces, all behind the seam:

1. **Redis node→instance routing registry**: `SET node:route:{nodeId} = {instanceId} EX 90`, written on `node.hello`, refreshed on every `node.heartbeat` (real interval **10s** per §13 → ~9 missed beats of slack), CAS-deleted on close. Ephemeral, Redis-only, never Postgres.
2. **Inbox-channel request/response correlation**: each instance subscribes to `bus:inst:{instanceId}` (awaited at boot **before** the instance accepts `node.hello`). B looks up the owner, publishes the request envelope (carrying `requestId` + `replyTo=B`) to the owner's inbox; reply frames are published back to `bus:inst:{replyTo}`, keyed by `requestId`, where B's SSE writer streams to the browser. Node-agent wire protocol (§10.5) is unchanged.
3. **EventBus seam**: `publish`/`subscribe` (fan-out topics), `publishToInstance` + `onInstanceMessage` (point-to-point correlated).

Two correctness fixes from review are folded into the dispatch service: (a) every forward-to-node path is guarded by `registry.isLocal(nodeId)` — a stale route is converted into an **immediate** `realtime.chat.error` back to `replyTo` instead of a silent drop, so the G3 router fallback actually fires; (b) the originating instance's `pending` map is cleaned up on terminal frames on **both** the local and cross-instance reply paths, plus a `timeoutMs`-driven sweeper, so no SSE sink leaks.

Job results (`job.completed`) remain durable via Postgres + BullMQ and are unaffected by WS affinity — only the ephemeral realtime token bridge transits the bus. `RealtimeSession` lifecycle (OPEN/CLOSED/FAILED/FALLBACK_USED) continues to persist on the owning instance; the bus carries tokens only.

**Prisma deltas:**

```
none.
```
Routing/liveness is ephemeral Redis state (TTL'd) — persisting it would create stale-route bugs after a crash. `ComputeNode.status` (ACTIVE/PROBATION/SUSPENDED, G1) and `RealtimeSession` (existing) are orthogonal and unchanged. An ops "which instance serves node X" view, if ever needed, is a Redis SCAN endpoint, not a column.

**Code:**

```ts
// ── apps/api/src/realtime/event-bus.interface.ts ─────────────────────────────
export const EVENT_BUS = Symbol('EVENT_BUS');
export const NODE_REGISTRY = Symbol('NODE_REGISTRY');

export interface BusEnvelope<T = unknown> {
  requestId: string;   // reuse §10.5 realtime rt_* id
  replyTo: string;     // instanceId of the originating instance
  type: string;        // e.g. 'realtime.chat.request' | '.token' | '.done' | '.error'
  payload: T;
}

export interface EventBus {
  readonly instanceId: string;                 // ULID at boot
  publish(topic: string, message: unknown): Promise<void>;
  subscribe(topic: string, handler: (message: unknown) => void): () => void;
  publishToInstance(instanceId: string, env: BusEnvelope): Promise<void>;
  onInstanceMessage(handler: (env: BusEnvelope) => void): () => void;
  /** Awaited at boot before the instance advertises readiness / accepts node.hello. */
  ready(): Promise<void>;
}

// ── apps/api/src/realtime/node-registry.interface.ts ─────────────────────────
export interface NodeRoute { nodeId: string; instanceId: string; }

export interface NodeConnectionRegistry {
  bind(nodeId: string): Promise<void>;     // after node.hello on this instance
  touch(nodeId: string): Promise<void>;    // §10.5 node.heartbeat handler (10s)
  release(nodeId: string): Promise<void>;  // WS close
  locate(nodeId: string): Promise<NodeRoute | null>;
  isLocal(nodeId: string): boolean;        // fast local truth
}

// ── apps/api/src/realtime/inprocess.adapters.ts ──────────────────────────────
// DEFAULT MVP BINDING.
import { EventEmitter } from 'events';
import { ulid } from 'ulid';
import type { EventBus, BusEnvelope } from './event-bus.interface';
import type { NodeConnectionRegistry, NodeRoute } from './node-registry.interface';

export class InProcessEventBus implements EventBus {
  readonly instanceId = ulid();
  private readonly ee = new EventEmitter();
  async ready() {/* nothing to await in-process */}
  async publish(topic: string, m: unknown) { this.ee.emit(`t:${topic}`, m); }
  subscribe(topic: string, h: (m: unknown) => void) {
    const f = (m: unknown) => h(m);
    this.ee.on(`t:${topic}`, f);
    return () => this.ee.off(`t:${topic}`, f);
  }
  async publishToInstance(_id: string, env: BusEnvelope) { this.ee.emit('inbox', env); }
  onInstanceMessage(h: (e: BusEnvelope) => void) {
    this.ee.on('inbox', h);
    return () => this.ee.off('inbox', h);
  }
}

export class InProcessNodeRegistry implements NodeConnectionRegistry {
  private readonly local = new Set<string>();
  constructor(private readonly bus: EventBus) {}
  async bind(n: string) { this.local.add(n); }
  async touch(_n: string) {/* no TTL in-process */}
  async release(n: string) { this.local.delete(n); }
  async locate(n: string): Promise<NodeRoute | null> {
    return this.local.has(n) ? { nodeId: n, instanceId: this.bus.instanceId } : null;
  }
  isLocal(n: string) { return this.local.has(n); }
}

// ── apps/api/src/realtime/redis.adapters.ts ──────────────────────────────────
// SCALING PATH. EVENTBUS_DRIVER=redis.
import Redis from 'ioredis';
import { ulid } from 'ulid';
import type { EventBus, BusEnvelope } from './event-bus.interface';
import type { NodeConnectionRegistry, NodeRoute } from './node-registry.interface';

const ROUTE = (n: string) => `node:route:${n}`;
const INBOX = (i: string) => `bus:inst:${i}`;
const TOPIC = (t: string) => `bus:topic:${t}`;
const ROUTE_TTL_S = 90; // node heartbeats every 10s (§13) → ~9 missed beats slack

export class RedisEventBus implements EventBus {
  readonly instanceId = ulid();
  private readonly sub: Redis;                  // dedicated subscriber (cannot issue cmds)
  private readonly topicHandlers = new Map<string, Set<(m: unknown) => void>>();
  private readonly inboxHandlers = new Set<(e: BusEnvelope) => void>();
  private readyPromise: Promise<void>;

  constructor(private readonly pub: Redis, subFactory: () => Redis) {
    this.sub = subFactory();
    // single shared subscriber + internal demux (avoids per-topic connection blowup)
    this.sub.on('message', (chan: string, raw: string) => {
      if (chan === INBOX(this.instanceId)) {
        const env = JSON.parse(raw) as BusEnvelope;
        for (const h of this.inboxHandlers) h(env);
        return;
      }
      const hs = this.topicHandlers.get(chan);
      if (hs) { const m = JSON.parse(raw); for (const h of hs) h(m); }
    });
    // boot ordering: inbox subscription MUST be live before we accept node.hello
    this.readyPromise = this.sub.subscribe(INBOX(this.instanceId)).then(() => undefined);
  }
  ready() { return this.readyPromise; }

  async publish(topic: string, m: unknown) { await this.pub.publish(TOPIC(topic), JSON.stringify(m)); }
  subscribe(topic: string, h: (m: unknown) => void) {
    const chan = TOPIC(topic);
    let set = this.topicHandlers.get(chan);
    if (!set) { set = new Set(); this.topicHandlers.set(chan, set); this.sub.subscribe(chan); }
    set.add(h);
    return () => {
      set!.delete(h);
      if (set!.size === 0) { this.topicHandlers.delete(chan); this.sub.unsubscribe(chan); }
    };
  }
  async publishToInstance(id: string, env: BusEnvelope) {
    await this.pub.publish(INBOX(id), JSON.stringify(env));
  }
  onInstanceMessage(h: (e: BusEnvelope) => void) {
    this.inboxHandlers.add(h);
    return () => this.inboxHandlers.delete(h);
  }
}

export class RedisNodeRegistry implements NodeConnectionRegistry {
  private readonly localSet = new Set<string>();
  constructor(private readonly redis: Redis, private readonly bus: EventBus) {}
  async bind(n: string) {
    this.localSet.add(n);
    await this.redis.set(ROUTE(n), this.bus.instanceId, 'EX', ROUTE_TTL_S);
  }
  async touch(n: string) {
    if (this.localSet.has(n)) await this.redis.set(ROUTE(n), this.bus.instanceId, 'EX', ROUTE_TTL_S);
  }
  async release(n: string) {
    this.localSet.delete(n);
    // CAS-delete: only clear the route if we still own it (don't clobber a reconnect elsewhere)
    const lua = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`;
    await this.redis.eval(lua, 1, ROUTE(n), this.bus.instanceId);
  }
  async locate(n: string): Promise<NodeRoute | null> {
    const id = await this.redis.get(ROUTE(n));
    return id ? { nodeId: n, instanceId: id } : null;
  }
  isLocal(n: string) { return this.localSet.has(n); }
}

// ── apps/api/src/realtime/realtime-dispatch.service.ts ───────────────────────
// Location-transparent realtime dispatch. Identical behavior under both adapters.
import { Injectable, Inject } from '@nestjs/common';
import { EVENT_BUS, NODE_REGISTRY } from './event-bus.interface';
import type { EventBus, BusEnvelope } from './event-bus.interface';
import type { NodeConnectionRegistry } from './node-registry.interface';
import { NodeGateway } from '../nodes/node.gateway'; // owns local Map<nodeId, WS>

type Frame = { type: string; text?: string; usage?: unknown; message?: string };
type TokenSink = (frame: Frame) => void;
const TERMINAL = (t: string) => t === 'realtime.chat.done' || t === 'realtime.chat.error';

@Injectable()
export class RealtimeDispatchService {
  // requestId -> { sink, timer } for replies routed back to THIS instance
  private readonly pending = new Map<string, { sink: TokenSink; timer: NodeJS.Timeout }>();

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(NODE_REGISTRY) private readonly registry: NodeConnectionRegistry,
    private readonly gateway: NodeGateway,
  ) {
    this.bus.onInstanceMessage((env) => {
      if (!env.type.startsWith('realtime.chat.')) return;

      // (A) Inbound REQUEST for a node we are supposed to own → forward down WS.
      if (env.type === 'realtime.chat.request') {
        const nodeId = (env.payload as any).nodeId as string;
        // FIX(high): guard stale route — never silently drop; emit error to replyTo.
        if (!this.registry.isLocal(nodeId)) {
          void this.bus.publishToInstance(env.replyTo, {
            requestId: env.requestId, replyTo: this.bus.instanceId,
            type: 'realtime.chat.error',
            payload: { type: 'realtime.chat.error', message: 'node not local (stale route)' },
          });
          return;
        }
        this.gateway.sendToLocalNode(nodeId, { ...(env.payload as any), __replyTo: env.replyTo });
        return;
      }

      // (B) Inbound reply (token/done/error) for a browser we serve → SSE sink.
      const entry = this.pending.get(env.requestId);
      if (entry) {
        entry.sink(env.payload as Frame);
        // FIX(high): clean up pending on terminal frames on the cross-instance path too.
        if (TERMINAL(env.type)) this.dropPending(env.requestId);
      }
    });
  }

  /** Called on the instance serving the browser SSE. */
  async streamFromNode(
    nodeId: string, req: object, requestId: string, sink: TokenSink, timeoutMs: number,
  ) {
    this.armPending(requestId, sink, timeoutMs);

    const route = await this.registry.locate(nodeId);
    if (!route) {
      sink({ type: 'realtime.chat.error', message: 'node offline' });
      this.dropPending(requestId);
      return;
    }

    const payload = { nodeId, requestId, ...req, __replyTo: this.bus.instanceId };
    if (route.instanceId === this.bus.instanceId) {
      // local fast path (always true in MVP) — but still verify we hold the socket.
      if (!this.registry.isLocal(nodeId)) {
        sink({ type: 'realtime.chat.error', message: 'node not local (stale route)' });
        this.dropPending(requestId);
        return;
      }
      this.gateway.sendToLocalNode(nodeId, payload);
    } else {
      const env: BusEnvelope = {
        requestId, replyTo: this.bus.instanceId,
        type: 'realtime.chat.request', payload,
      };
      await this.bus.publishToInstance(route.instanceId, env);
    }
  }

  /** Called by NodeGateway when a node WS emits a realtime frame. */
  async onNodeFrame(frame: { requestId: string; __replyTo: string; type: string } & Frame) {
    if (frame.__replyTo === this.bus.instanceId) {
      const entry = this.pending.get(frame.requestId);
      if (entry) {
        entry.sink(frame);
        if (TERMINAL(frame.type)) this.dropPending(frame.requestId);
      }
    } else {
      await this.bus.publishToInstance(frame.__replyTo, {
        requestId: frame.requestId, replyTo: this.bus.instanceId,
        type: frame.type, payload: frame,
      });
    }
  }

  cancel(requestId: string) { this.dropPending(requestId); }

  // ── pending lifecycle (single owner of the Map; no leaks) ──
  private armPending(requestId: string, sink: TokenSink, timeoutMs: number) {
    const timer = setTimeout(() => {
      sink({ type: 'realtime.chat.error', message: 'realtime timeout' });
      this.pending.delete(requestId); // router fallback (G3) handles re-route pre-first-token
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(requestId, { sink, timer });
  }
  private dropPending(requestId: string) {
    const e = this.pending.get(requestId);
    if (e) { clearTimeout(e.timer); this.pending.delete(requestId); }
  }
}

// ── apps/api/src/realtime/realtime.module.ts ─────────────────────────────────
import { Module, Global } from '@nestjs/common';
import Redis from 'ioredis';
import { EVENT_BUS, NODE_REGISTRY } from './event-bus.interface';
import { InProcessEventBus, InProcessNodeRegistry } from './inprocess.adapters';
import { RedisEventBus, RedisNodeRegistry } from './redis.adapters';

const useRedis = process.env.EVENTBUS_DRIVER === 'redis';

@Global()
@Module({
  providers: [
    {
      provide: EVENT_BUS,
      useFactory: () =>
        useRedis
          ? new RedisEventBus(new Redis(process.env.REDIS_URL!), () => new Redis(process.env.REDIS_URL!))
          : new InProcessEventBus(),
    },
    {
      provide: NODE_REGISTRY,
      inject: [EVENT_BUS],
      useFactory: (bus) =>
        useRedis
          ? new RedisNodeRegistry(new Redis(process.env.REDIS_URL!), bus)
          : new InProcessNodeRegistry(bus),
    },
  ],
  exports: [EVENT_BUS, NODE_REGISTRY],
})
export class RealtimeModule {}

// NodeGateway wiring (sketch):
//   bootstrap()       -> await bus.ready();              // before accepting node.hello
//   on node.hello     -> await registry.bind(nodeId);
//   on node.heartbeat -> await registry.touch(nodeId);   // 10s
//   on close          -> await registry.release(nodeId);
//   sendToLocalNode(nodeId, msg) { /* write existing local Map<nodeId, WS> */ }
//   on realtime frame -> dispatch.onNodeFrame(frame);
// Lint boundary: no import of `ws`/gateway internals outside apps/api/src/realtime + nodes/node.gateway.
```

**Spec patch:**

- **§6.1 Backend** — append to the code block after "Chat streaming: Server-Sent Events first, WebSocket later":
  ```txt
  Realtime bus: EventBus abstraction (node<->browser bridge)
    - MVP: single NestJS process, in-process EventBus + node registry (default)
    - Scale path (post-MVP, EVENTBUS_DRIVER=redis): Redis pub/sub bus +
      Redis node->instance routing registry; node WS and browser SSE may live
      on different instances. No API code references a concrete transport.
  Instance identity: each API process gets a ULID instanceId at boot.
  ```
- **§10.5** — insert new subsection **§10.5.1** **after line 1104** (end of the Server→Client JSON message blocks, immediately before `## 10.6 Jobs`); note these are JSON message blocks, not tables:
  ```txt
  ## 10.5.1 Connection routing (single-process MVP; Redis scale path)

  Invariant: one node = one outbound WebSocket = one owning API instance.

  MVP (default): single process. Map<nodeId, WebSocket> + in-process EventBus.
  No coordination needed.

  Horizontal scaling (EVENTBUS_DRIVER=redis), location-transparent:
  - Routing registry (Redis, ephemeral, TTL'd, never Postgres):
      SET node:route:{nodeId} = {instanceId}  EX 90
      written on node.hello, refreshed on node.heartbeat (every 10s, §13),
      CAS-deleted on close.
  - Each instance subscribes to bus:inst:{instanceId}; the inbox subscription
      is awaited at boot BEFORE the instance accepts node.hello.
  - Dispatch: the instance serving the browser SSE looks up node:route:{nodeId};
      if local (verified via isLocal) it writes the WS directly, else it
      PUBLISHES a realtime.chat.request envelope to the owner's inbox. The
      receiving instance re-checks isLocal; a stale route yields an immediate
      realtime.chat.error back to replyTo (never a silent drop). Reply frames
      (token/done/error) are published to the originating instance's inbox,
      keyed by requestId, where the SSE writer streams them to the browser.
  - Envelope adds two transport fields only: requestId (reuse rt_*) + replyTo
      (originating instanceId). Node-agent wire protocol is UNCHANGED.
  - Fan-out topics (node status, dashboards) use bus:topic:{name}.

  Delivery semantics: realtime tokens are best-effort. The in-flight requestId
  fails with realtime.chat.error on owner-death, stale route, or timeoutMs
  expiry. Automatic router fallback (§11) applies only BEFORE the first token;
  death AFTER first token surfaces a terminal error and the user retries
  (no mid-stream resumption — explicitly out of scope). Job results
  (job.completed) are durable via Postgres + BullMQ, independent of WS affinity.
  RealtimeSession (OPEN/CLOSED/FAILED/FALLBACK_USED) persists on the owning
  instance; only the token bridge transits the bus.

  Load balancing: browser SSE may land on any instance (no sticky sessions);
  only node WS affinity is tracked, by the registry.
  ```
- **§11** — adjust the fallback note so it does not claim mid-stream re-route: fallback re-routes only before the first token is emitted; a mid-stream failure is terminal for that requestId.

**Known limitations:**
1. **Stale-route window (≤90s)** on uncleaned crash: `locate()` may point at a dead instance; the receiving-side `isLocal` guard + timeout now turn this into an immediate `realtime.chat.error` → G3 fallback. Self-heals on node reconnect (`bind` overwrites; CAS-delete prevents clobber). Could tighten `ROUTE_TTL_S` toward 30–45s given the 10s heartbeat. (N/A in MVP.)
2. **No at-least-once for tokens** — a dropped pub/sub message loses ephemeral tokens; acceptable for chat, which is exactly why durable job results stay on Postgres/BullMQ, not the bus.
3. **No mid-stream resumption** — failover after the first token is terminal (user retries); idempotent partial-replay is a separate, out-of-scope design.
4. **Hot-node head-of-line** — all traffic for one node funnels through its single owning instance/WS by design (outbound-only node); a saturating node is a placement/capacity problem, mitigated later via per-node concurrency caps implied by G1 reputation/probation.
5. **Split-brain double-bind** — a partition can briefly contend two routes; last-writer-wins SET + CAS-delete converges, bounded by WS TCP keepalive; monitor a duplicate-route metric post-MVP.
6. **Abstraction-drift risk** — the swap stays a one-line DI change only if nothing reaches past `EventBus`/`NodeConnectionRegistry`; enforce with a lint import-boundary on `ws`/gateway internals.

---

This is a spec-only task. The decided solution and review are already provided; I need to fold the high-severity findings into a final artifact. No file exploration needed—I have everything. Let me produce the final resolution.

### G12 — Reward emission rate-limit vs Compute Rewards Pool

**Decision:** ADOPT a DB-backed `EmissionSchedule` + `EmissionEpoch` ledger that throttles the credit→NRN *conversion* (never credit accrual). G1's post-VERIFIED gating is unchanged; G12 sits strictly after it. Internal credits always accrue (`CreditLedger.NODE_REWARD`, `@@unique([jobId,reason])` preserved); only NRN issuance is rate-limited. When the current UTC-day epoch budget or the lifetime pool cannot fund a payout, the `TokenPayout` is created/kept `QUEUED` (never `FAILED`) and retried by a per-epoch drain worker — no reward is lost, only deferred. Folding the four high/blocker findings:

1. **Real physical cap (finding 1).** The vault is *funded with exactly the pool* at deploy (`§17` patched). Reconciliation no longer conflates logical reservations with on-chain transfers: it compares **vault balance vs `(initialVaultFundingWei − Σ CONFIRMED payout amountWei)`** — like-for-like, on-chain against on-chain. `emittedLifetimeWei` remains the *separate* logical cap that gates new reservations. PENDING/QUEUED/SUBMITTED rows therefore can't trip drift.
2. **Automatic release on failure (finding 2).** `release()` is wired into the `FAILED`/`CANCELLED` transition, keyed on `emissionEpochIndex`, made idempotent by a new `emissionReleased` boolean. QUEUED rows cancelled before any reservation never call release (they were never reserved).
3. **No permanent fail-stuck (finding 3).** `carryoverInWei` roll-forward is actually implemented (cumulative running-unspent counter on the schedule, O(1)). After year 8 the per-epoch budget falls back to "drain remaining pool" instead of hard `0`, so the **pool, not the clock,** is the terminal condition. A single reward larger than a full epoch's available budget is rejected up front (`rewardExceedsEpochBudget`) rather than deadlocking — caller must split/aggregate differently.
4. **Concurrency (finding 5, medium→folded).** Reservation now uses `SELECT … FOR UPDATE` row locks on the singleton + epoch row (cheap at single-VPS payout QPS), eliminating the optimistic-race-spurious-QUEUE class entirely. Drain promotion is status-guarded (`updateMany WHERE status='QUEUED'`) and the worker runs `concurrency:1`.

**Prisma deltas:**
```prisma
// ── G12: Emission rate-limit vs Compute Rewards Pool ──────────────

// Singleton (id = "SINGLETON") authoritative LOGICAL emission ledger.
model EmissionSchedule {
  id                  String   @id @default("SINGLETON")
  poolWei             String   // 400_000_000 * 1e18, immutable logical cap
  emittedLifetimeWei  String   @default("0")     // logical reservations (incl. PENDING/QUEUED→PENDING)
  unspentCarryoverWei String   @default("0")     // running pool of budget unspent by closed epochs
  lastClosedEpochIndex Int     @default(-1)      // highest epoch fully rolled into carryover
  startedAt           DateTime @default(now())
  epochKind           String   @default("DAILY")
  totalYears          Int      @default(8)
  // Physical cap reconciliation (on-chain, like-for-like):
  initialVaultFundingWei String?                 // vault funded == pool at deploy
  onChainVaultWei        String?                 // last observed ComputeRewardVault NRN balance
  emissionHalted      Boolean  @default(false)
  haltReason          String?
  lastReconciledAt    DateTime?
  updatedAt           DateTime @updatedAt

  epochs              EmissionEpoch[]
}

// One row per epoch (UTC day). Created lazily on first reward of the epoch.
model EmissionEpoch {
  id                  String   @id @default(cuid())
  scheduleId          String   @default("SINGLETON")
  epochIndex          Int      // days since startedAt (UTC), 0-based
  epochStart          DateTime // UTC midnight of the epoch
  budgetWei           String   // base curve budget for this epoch
  carryoverInWei      String   @default("0") // unspent budget rolled in from prior epochs
  emittedThisEpochWei String   @default("0")
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  schedule            EmissionSchedule @relation(fields: [scheduleId], references: [id])

  @@unique([scheduleId, epochIndex])
  @@index([epochStart])
}
```
Enum + `TokenPayout` additions (additive, non-breaking; `CreditLedgerReason` unchanged):
```prisma
enum PayoutStatus {
  PENDING
  SUBMITTED
  CONFIRMED
  FAILED
  CANCELLED
  BLOCKED
  QUEUED      // G12: verified but emission budget/pool exhausted; retries next epoch
}

model TokenPayout {
  // ...existing fields...
  emissionEpochIndex  Int?      // G12: epoch that funded this payout (null while QUEUED)
  queuedAt            DateTime? // G12: first parked as QUEUED
  emissionReleased    Boolean   @default(false) // G12: idempotency guard for release() on FAIL/CANCEL
}
```

**Code:**
```ts
// ── packages/api/src/tokens/emission-schedule.constants.ts ──────────
import { CREDIT_TO_NRN_WEI } from "./conversion.constants";

export const NRN_DECIMALS_WEI = BigInt("1000000000000000000"); // 1e18
export const TOTAL_SUPPLY_WEI = BigInt(1_000_000_000) * NRN_DECIMALS_WEI;
// 40% Compute Rewards Pool — HARD logical cap; vault is funded with EXACTLY this.
export const COMPUTE_REWARDS_POOL_WEI = (TOTAL_SUPPLY_WEI * BigInt(40)) / BigInt(100); // 400M NRN
export const EMISSION_YEARS = 8;
export const DAYS_PER_YEAR = 365;

// Front-loaded 8-year curve. Weights sum to 100. Year tranche = pool * w / 100.
export const EMISSION_YEAR_WEIGHTS = [22, 18, 15, 13, 11, 9, 7, 5]; // = 100

/** Base curve budget for a given epoch index. After year 8 returns 0; the
 *  service falls back to "drain remaining pool" so the cap, not the clock, ends it. */
export function epochBaseBudgetWei(epochIndex: number): bigint {
  const yearIndex = Math.floor(epochIndex / DAYS_PER_YEAR);
  if (yearIndex >= EMISSION_YEARS) return BigInt(0);
  const w = BigInt(EMISSION_YEAR_WEIGHTS[yearIndex]);
  const yearTrancheWei = (COMPUTE_REWARDS_POOL_WEI * w) / BigInt(100);
  return yearTrancheWei / BigInt(DAYS_PER_YEAR);
}

export function epochIndexFor(startedAt: Date, now: Date): number {
  const ms =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate());
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export function epochStartUtc(startedAt: Date, epochIndex: number): Date {
  const base = Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate());
  return new Date(base + epochIndex * 86_400_000);
}

// ── packages/api/src/tokens/emission.service.ts ─────────────────────
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  COMPUTE_REWARDS_POOL_WEI, DAYS_PER_YEAR, EMISSION_YEARS,
  epochBaseBudgetWei, epochIndexFor, epochStartUtc,
} from "./emission-schedule.constants";

export type EmissionDenyReason =
  | "POOL_EXHAUSTED" | "EPOCH_BUDGET_EXHAUSTED" | "HALTED" | "REWARD_EXCEEDS_EPOCH_BUDGET";

export interface EmissionReservation {
  granted: boolean;
  epochIndex: number;
  shortfallWei: bigint;
  reason?: EmissionDenyReason;
}

@Injectable()
export class EmissionService {
  private readonly log = new Logger(EmissionService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ensure singleton + current epoch exist, rolling unspent budget of every
   * now-closed prior epoch into unspentCarryoverWei (O(1) via lastClosedEpochIndex).
   * MUST run inside a tx that already holds the singleton row lock (see reserve()).
   */
  private async ensureEpoch(tx: any, now = new Date()) {
    let sched = await tx.emissionSchedule.findUnique({ where: { id: "SINGLETON" } });
    if (!sched) {
      sched = await tx.emissionSchedule.create({
        data: { id: "SINGLETON", poolWei: COMPUTE_REWARDS_POOL_WEI.toString() },
      });
    }
    const epochIndex = epochIndexFor(sched.startedAt, now);

    // Roll every epoch in (lastClosedEpochIndex, epochIndex) into carryover.
    let carry = BigInt(sched.unspentCarryoverWei);
    let cursor = sched.lastClosedEpochIndex;
    if (cursor < epochIndex - 1) {
      const closed = await tx.emissionEpoch.findMany({
        where: { scheduleId: "SINGLETON", epochIndex: { gt: cursor, lt: epochIndex } },
      });
      const byIdx = new Map<number, any>(closed.map((e: any) => [e.epochIndex, e]));
      for (let i = cursor + 1; i < epochIndex; i++) {
        const e = byIdx.get(i);
        const avail = e
          ? BigInt(e.budgetWei) + BigInt(e.carryoverInWei) - BigInt(e.emittedThisEpochWei)
          : epochBaseBudgetWei(i); // epoch never materialized => its whole budget is unspent
        carry += avail < BigInt(0) ? BigInt(0) : avail;
      }
      cursor = epochIndex - 1;
      sched = await tx.emissionSchedule.update({
        where: { id: "SINGLETON" },
        data: { unspentCarryoverWei: carry.toString(), lastClosedEpochIndex: cursor },
      });
    }

    // Base budget; after year 8, fall back to "drain remaining pool" so pool is terminal.
    const yearIndex = Math.floor(epochIndex / DAYS_PER_YEAR);
    const poolRemaining = BigInt(sched.poolWei) - BigInt(sched.emittedLifetimeWei);
    const base = yearIndex >= EMISSION_YEARS ? poolRemaining : epochBaseBudgetWei(epochIndex);

    await tx.emissionEpoch.upsert({
      where: { scheduleId_epochIndex: { scheduleId: "SINGLETON", epochIndex } },
      create: {
        scheduleId: "SINGLETON", epochIndex,
        epochStart: epochStartUtc(sched.startedAt, epochIndex),
        budgetWei: base.toString(),
        carryoverInWei: BigInt(sched.unspentCarryoverWei).toString(),
      },
      update: {},
    });
    return { sched, epochIndex };
  }

  /**
   * Atomically reserve amountWei against pool + current-epoch budget using
   * SELECT ... FOR UPDATE row locks (no optimistic race). Throttles, never drops.
   * Call INSIDE the payout $transaction.
   */
  async reserve(tx: any, amountWei: bigint, now = new Date()): Promise<EmissionReservation> {
    // Serialize all reservations on the singleton row.
    await tx.$executeRawUnsafe(`SELECT id FROM "EmissionSchedule" WHERE id = 'SINGLETON' FOR UPDATE`);

    const { sched, epochIndex } = await this.ensureEpoch(tx, now);
    if (sched.emissionHalted) return { granted: false, epochIndex, shortfallWei: amountWei, reason: "HALTED" };

    await tx.$executeRawUnsafe(
      `SELECT id FROM "EmissionEpoch" WHERE "scheduleId" = 'SINGLETON' AND "epochIndex" = $1 FOR UPDATE`,
      epochIndex,
    );
    const epoch = await tx.emissionEpoch.findUnique({
      where: { scheduleId_epochIndex: { scheduleId: "SINGLETON", epochIndex } },
    });

    const poolRemaining = BigInt(sched.poolWei) - BigInt(sched.emittedLifetimeWei);
    if (amountWei > poolRemaining)
      return { granted: false, epochIndex, shortfallWei: amountWei - poolRemaining, reason: "POOL_EXHAUSTED" };

    const epochBudget = BigInt(epoch.budgetWei) + BigInt(epoch.carryoverInWei);
    const epochAvail = epochBudget - BigInt(epoch.emittedThisEpochWei);
    // Hard liveness guard: a single reward larger than a FULL epoch budget can
    // never be granted — reject instead of deadlocking it as perpetual QUEUED.
    if (amountWei > epochBudget)
      return { granted: false, epochIndex, shortfallWei: amountWei - epochBudget, reason: "REWARD_EXCEEDS_EPOCH_BUDGET" };
    if (amountWei > epochAvail)
      return { granted: false, epochIndex, shortfallWei: amountWei - epochAvail, reason: "EPOCH_BUDGET_EXHAUSTED" };

    await tx.emissionEpoch.update({
      where: { scheduleId_epochIndex: { scheduleId: "SINGLETON", epochIndex } },
      data: { emittedThisEpochWei: (BigInt(epoch.emittedThisEpochWei) + amountWei).toString() },
    });
    await tx.emissionSchedule.update({
      where: { id: "SINGLETON" },
      data: { emittedLifetimeWei: (BigInt(sched.emittedLifetimeWei) + amountWei).toString() },
    });
    return { granted: true, epochIndex, shortfallWei: BigInt(0) };
  }

  /** Release a reservation back to pool + its epoch (FAILED/CANCELLED on-chain). */
  async release(tx: any, amountWei: bigint, epochIndex: number) {
    await tx.$executeRawUnsafe(`SELECT id FROM "EmissionSchedule" WHERE id = 'SINGLETON' FOR UPDATE`);
    await tx.$executeRawUnsafe(
      `UPDATE "EmissionSchedule" SET "emittedLifetimeWei" =
         GREATEST(0, CAST("emittedLifetimeWei" AS NUMERIC) - $1)::text WHERE id = 'SINGLETON'`,
      amountWei.toString(),
    );
    await tx.$executeRawUnsafe(
      `UPDATE "EmissionEpoch" SET "emittedThisEpochWei" =
         GREATEST(0, CAST("emittedThisEpochWei" AS NUMERIC) - $1)::text
       WHERE "scheduleId" = 'SINGLETON' AND "epochIndex" = $2`,
      amountWei.toString(), epochIndex,
    );
  }
}

// ── RewardAccountingService: convert verified credits -> NRN payout (G12) ──
// Runs AFTER G1 verification + after CreditLedger NODE_REWARD is written.
async function convertVerifiedRewardToPayout(
  this: { prisma: PrismaService; emission: EmissionService },
  args: { userId: string; jobId: string; walletAddress: string; chainId: number; credits: number },
) {
  const amountWei = BigInt(args.credits) * CREDIT_TO_NRN_WEI;
  const base = {
    userId: args.userId, jobId: args.jobId, walletAddress: args.walletAddress,
    tokenSymbol: "NRN", amountWei: amountWei.toString(), chainId: args.chainId,
  };
  return this.prisma.$transaction(async (tx) => {
    const res = await this.emission.reserve(tx, amountWei);
    if (res.granted) {
      return tx.tokenPayout.create({
        data: { ...base, status: "PENDING", emissionEpochIndex: res.epochIndex },
      });
    }
    // Throttle, do NOT fail: park QUEUED, retried next epoch. Credits stay owed.
    // REWARD_EXCEEDS_EPOCH_BUDGET also queues but is alerted (will never self-resolve).
    return tx.tokenPayout.create({
      data: { ...base, status: "QUEUED", queuedAt: new Date(),
        errorMessage: `emission_throttled:${res.reason}` },
    });
  });
}

// ── Payout state machine: release reservation on FAILED / CANCELLED ──
// Wired into the confirmation watcher / payout transitions. Idempotent via emissionReleased.
async function onPayoutFailedOrCancelled(
  prisma: PrismaService, emission: EmissionService, payoutId: string,
) {
  await prisma.$transaction(async (tx) => {
    // Lock the payout row; only release if it actually held a reservation and hasn't released.
    const updated = await tx.tokenPayout.updateMany({
      where: { id: payoutId, emissionReleased: false, emissionEpochIndex: { not: null } },
      data: { emissionReleased: true },
    });
    if (updated.count !== 1) return; // never reserved (QUEUED) or already released — no-op
    const p = await tx.tokenPayout.findUniqueOrThrow({ where: { id: payoutId } });
    await emission.release(tx, BigInt(p.amountWei), p.emissionEpochIndex!);
  });
}

// ── BullMQ worker (concurrency:1): drain QUEUED payouts at epoch boundary ──
// cron UTC 00:05. Status-guarded promotion prevents double-reserve.
async function drainQueuedPayouts(prisma: PrismaService, emission: EmissionService) {
  const queued = await prisma.tokenPayout.findMany({
    where: { status: "QUEUED" }, orderBy: { queuedAt: "asc" }, take: 500,
  });
  for (const p of queued) {
    await prisma.$transaction(async (tx) => {
      // Claim the row first; bail if a concurrent path already promoted it.
      const claim = await tx.tokenPayout.updateMany({
        where: { id: p.id, status: "QUEUED" }, data: { status: "QUEUED" },
      });
      if (claim.count !== 1) return;
      const res = await emission.reserve(tx, BigInt(p.amountWei));
      if (res.granted) {
        await tx.tokenPayout.update({
          where: { id: p.id },
          data: { status: "PENDING", emissionEpochIndex: res.epochIndex, errorMessage: null },
        });
      } // else leave QUEUED for a later epoch
    });
  }
}

// ── Reconcile vs on-chain ComputeRewardVault — LIKE-FOR-LIKE (finding 1) ──
// Compares vault balance against (initialVaultFunding - sum CONFIRMED on-chain payouts),
// NOT against the logical emittedLifetimeWei (which includes PENDING/QUEUED→PENDING).
async function reconcileWithVault(
  prisma: PrismaService, vaultBalanceWei: bigint, toleranceWei = BigInt(0),
) {
  const sched = await prisma.emissionSchedule.findUniqueOrThrow({ where: { id: "SINGLETON" } });
  const funded = BigInt(sched.initialVaultFundingWei ?? sched.poolWei);
  const confirmed = await prisma.tokenPayout.aggregate({
    where: { status: "CONFIRMED" }, _sum: { /* numeric agg done in SQL for wei */ } as any,
  });
  // amountWei is a String column -> sum via raw SQL:
  const [{ sum }] = await prisma.$queryRawUnsafe<{ sum: string }[]>(
    `SELECT COALESCE(SUM(CAST("amountWei" AS NUMERIC)),0)::text AS sum
       FROM "TokenPayout" WHERE status = 'CONFIRMED'`,
  );
  const expectedVault = funded - BigInt(sum);
  const drift = vaultBalanceWei > expectedVault
    ? vaultBalanceWei - expectedVault : expectedVault - vaultBalanceWei;

  const data: any = { lastReconciledAt: new Date(), onChainVaultWei: vaultBalanceWei.toString() };
  if (drift > toleranceWei) {
    data.emissionHalted = true;
    data.haltReason = `vault_drift:expectedVault=${expectedVault} actual=${vaultBalanceWei}`;
    // also write ComplianceRecord + AuditLog and page COMPLIANCE role (omitted)
  }
  await prisma.emissionSchedule.update({ where: { id: "SINGLETON" }, data });
}
```

**Spec patch:** Patch `NEURION_SPEC_Codex_IT_EN_v1.1.md`:

1. **§16.5 Vesting** — replace the *Compute Rewards* block:
```txt
Compute Rewards:
  emission over 8 years, released by verified useful compute
  runtime-enforced by EmissionSchedule (see §16.8):
    - per-UTC-day epoch budget from a declining 8-year curve [22,18,15,13,11,9,7,5]
    - unspent epoch budget rolls forward (carryover); after year 8 the
      remaining pool drains (pool, not clock, is terminal)
    - hard lifetime cap = 40% = 400,000,000 NRN
    - over-rate / over-pool requests are QUEUED, never minted (cross-ref §16.8)
```

2. **New §16.8 "Emission rate-limit (G12)"** (after §16.7):
```txt
## 16.8 Emission schedule & rate-limit (G12)

Invariant (HARD): lifetime NRN emitted from the Compute Rewards Pool MUST NEVER
exceed 400,000,000 NRN. Enforced (a) LOGICALLY in DB — EmissionSchedule.
emittedLifetimeWei <= poolWei, guarded by SELECT..FOR UPDATE row locks; and
(b) PHYSICALLY on-chain — ComputeRewardVault is funded at deploy with EXACTLY
the 400M pool (§17), so token.transfer reverts once that balance is exhausted.

Epoch: 1 UTC day. Per-epoch budget = annual tranche (weights [22,18,15,13,11,9,
7,5], sum 100) split evenly over 365 days, PLUS carryover of all unspent prior-
epoch budget. After year 8 the per-epoch budget falls back to the remaining
pool so emission completes on pool exhaustion, not on the clock.

Throttle semantics (reconciles with G1): rewards are credited ONLY post-VERIFIED
(G1 unchanged). EmissionSchedule governs the credit->NRN *conversion* that
follows. Internal credits ALWAYS accrue (CreditLedger NODE_REWARD,
@@unique([jobId,reason]) preserved). When epoch budget OR lifetime pool cannot
fund a payout, the TokenPayout is created QUEUED (not FAILED); a per-epoch drain
worker (concurrency 1, status-guarded) retries it as budget reopens. A single
reward larger than a full epoch budget is rejected (REWARD_EXCEEDS_EPOCH_BUDGET)
and alerted rather than deadlocked.

Release: on FAILED/CANCELLED on-chain, release() returns the reservation to pool
+ epoch, idempotent via TokenPayout.emissionReleased.

Reconciliation (LIKE-FOR-LIKE): a daily job compares the live ComputeRewardVault
NRN balance against (initialVaultFundingWei − Σ CONFIRMED TokenPayout.amountWei)
— on-chain vs on-chain only; PENDING/QUEUED reservations are excluded. Drift
beyond tolerance sets emissionHalted=true, writes ComplianceRecord + AuditLog,
pages COMPLIANCE. While halted, reserve() denies all emissions (payouts QUEUE).
```

3. **§17 (NRNToken / ComputeRewardVault)** — add a funding requirement:
```txt
Deploy step: after NRNToken mints MAX_SUPPLY to initialOwner, EXACTLY
400,000,000 NRN (the Compute Rewards Pool) is transferred into ComputeRewardVault.
This funded balance IS the physical emission cap and is recorded as
EmissionSchedule.initialVaultFundingWei. The vault holds only the pool; no other
allocation is ever deposited.
```

4. **§18.1 Services** — resolve ownership (row creation stays in `TokenPayoutService`, finding 6):
```txt
RewardAccountingService:
  converts verified credits to NRN amount; delegates persistence to
  TokenPayoutService. Does NOT create payout rows.
TokenPayoutService:
  creates payout rows; calls EmissionService.reserve inside the create
  transaction -> status PENDING if granted, else QUEUED; on FAILED/CANCELLED
  calls EmissionService.release (idempotent via emissionReleased); submits/
  confirms tx.
EmissionService:
  owns EmissionSchedule/EmissionEpoch; reserve()/release() enforce per-epoch
  budget + hard pool cap atomically under row locks; reconcileWithVault()
  (like-for-like) and a per-epoch drainQueuedPayouts() worker.
```

5. **§18.2 Payout flow** — restate in full (renumbered 1–10):
```txt
1. G1 verification completes (job VERIFIED).
2. CreditLedger NODE_REWARD written (credits accrue; @@unique([jobId,reason])).
3. RewardAccountingService computes NRN testnet amount from credits.
4. EmissionService.reserve(amount): under row locks, debits epoch budget +
   lifetime pool. Insufficient/halted/oversized => not granted.
5. TokenPayoutService creates the row: PENDING if reserved, else QUEUED
   (credits already granted, retried next epoch).
6. Admin/processor submits the tx for PENDING rows -> SUBMITTED.
7. ComputeRewardVault pays out; txHash recorded.
8. Confirmation watcher marks CONFIRMED.
9. On FAILED/CANCELLED: TokenPayoutService calls EmissionService.release
   (idempotent) returning budget to pool + epoch.
10. Per-epoch worker (UTC 00:05, concurrency 1) drains QUEUED -> PENDING as
    budget reopens.
```
Also add `QUEUED` to the `PayoutStatus` enum documented near §9 schema, and add `emissionEpochIndex`, `queuedAt`, `emissionReleased` to the documented `TokenPayout` fields.

**Known limitations:** (1) The [22,18,15,13,11,9,7,5] annual curve is a tokenomics policy choice, not derived from a bonding formula — needs sign-off; heavy early demand still defers (not loses) NRN via QUEUED. (2) `release()` correctness depends on every FAILED/CANCELLED transition routing through `onPayoutFailedOrCancelled`; a sweep job should periodically reconcile non-released terminal payouts against reservations as belt-and-suspenders. (3) Wei arithmetic in `release()`/reconcile uses Postgres `CAST AS NUMERIC` (DB-specific). (4) Fixed 365-day accounting years cause ~0.27%/yr index drift vs wall-clock; immaterial since the cap is absolute and year-8+ falls back to pool-drain. (5) QUEUED ordering is `queuedAt` FIFO with no partial fills, so within a constrained epoch a large early payout can defer smaller ones; the oversized-single-reward case is rejected up front rather than stuck. (6) Carryover roll-forward scan is bounded by `lastClosedEpochIndex` (O(1) amortized) but a long idle gap triggers one catch-up `findMany` over the skipped epoch rows.

---

### G13 — TOKEN_PAYOUTS_ENABLED missing from env

**Decision:** Add `TOKEN_PAYOUTS_ENABLED` as the global payout kill-switch, surfaced via a typed `registerAs('token')` config and `TokenConfigService.payoutsEnabled`. Enforcement primary point is `TokenPayoutService` (covers HTTP **and** BullMQ/cron worker paths) with a mandatory assertion before any tx submission; `PayoutsEnabledGuard` is an additional HTTP-layer fast-fail (placed LAST so 401/403 take precedence over the 503 kill-switch signal). Gate only the two write endpoints (`POST /api/token/request-payout`, `POST /api/token/admin/process-payouts`); read endpoints (`/api/token/config`, `/api/token/payouts`) stay open so the UI renders a "payouts disabled" state. Layering decision: `.env.example` **is** the local/testnet profile (ships `CHAIN_ID=31337`, local RPC, seed creds), so it sets `TOKEN_PAYOUTS_ENABLED=true` consistent with the §23 local-demo intent and G4 "40 PDF" payout walkthrough; the `registerAs` factory default and the canonical production posture are **fail-closed (`false`)** — a forgotten/absent env in any non-local deploy can never silently allow on-chain payouts. This is the global layer of §19.2; per-user/node `KycStatus.PAYOUT_BLOCKED` + `ComplianceFlagService` gating is orthogonal and still applies on top.

**Prisma deltas:** none — global kill-switch is env/config only; per-user/node blocking already lives in `KycStatus.PAYOUT_BLOCKED` + `ComplianceRecord`.

**Code:**
```ts
// ── .env.example (local/testnet profile) — add under "# Crypto", after CREDIT_TO_NRN_WEI ──
// Global token payout kill-switch. This file is the LOCAL/TESTNET profile, so it is ON.
// Production/non-local deploys MUST omit or set false; the config factory defaults to false (fail-closed).
TOKEN_PAYOUTS_ENABLED=true

// ── apps/api/src/config/token.config.ts (new) ──
import { registerAs } from '@nestjs/config';

const asBool = (v: string | undefined, fallback = false): boolean =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());

export interface TokenConfig {
  payoutsEnabled: boolean;
  chainId: number;
  creditToNrnWei: string;
}

export default registerAs('token', (): TokenConfig => ({
  // Fail-closed: absent/invalid/typo => payouts disabled.
  payoutsEnabled: asBool(process.env.TOKEN_PAYOUTS_ENABLED, false),
  chainId: Number(process.env.CHAIN_ID ?? 31337),
  creditToNrnWei: process.env.CREDIT_TO_NRN_WEI ?? '0',
}));
// Register: ConfigModule.forRoot({ load: [tokenConfig, /* ...others */], isGlobal: true })

// ── apps/api/src/token/token-config.service.ts (delta) ──
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TokenConfig } from '../config/token.config';

@Injectable()
export class TokenConfigService {
  /** Snapshotted at boot (registerAs already froze process.env). */
  readonly payoutsEnabled: boolean;
  private readonly token: TokenConfig;

  constructor(private readonly config: ConfigService) {
    this.token = this.config.getOrThrow<TokenConfig>('token');
    this.payoutsEnabled = this.token.payoutsEnabled;
  }

  /** GET /api/token/config — keep full §18.1 shape, just add payoutsEnabled. */
  publicConfig() {
    return { ...this.existingTokenMeta(), payoutsEnabled: this.payoutsEnabled };
  }

  // existingTokenMeta(): tokenAddress, vaultAddress, abi, chainId, decimals — unchanged per §18.1.
  private existingTokenMeta() {
    return { chainId: this.token.chainId /* + tokenAddress, vaultAddress, abi, decimals */ };
  }
}

// ── apps/api/src/token/payouts-enabled.guard.ts (new) ──
import { CanActivate, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { TokenConfigService } from './token-config.service';

@Injectable()
export class PayoutsEnabledGuard implements CanActivate {
  constructor(private readonly tokenConfig: TokenConfigService) {}

  canActivate(): boolean {
    if (!this.tokenConfig.payoutsEnabled) {
      throw new ServiceUnavailableException('TOKEN_PAYOUTS_DISABLED'); // 503, not auth failure
    }
    return true;
  }
}

// ── apps/api/src/token/token.service.ts (delta) — PRIMARY enforcement (HTTP + worker) ──
// Mandatory assertion at the top of EVERY write/tx path. This is the real kill-switch;
// the guard is only an HTTP fast-fail and does NOT protect BullMQ/cron workers.
@Injectable()
export class TokenPayoutService {
  constructor(private readonly tokenConfig: TokenConfigService /* ... */) {}

  private assertPayoutsEnabled(): void {
    if (!this.tokenConfig.payoutsEnabled) {
      throw new ServiceUnavailableException('TOKEN_PAYOUTS_DISABLED');
    }
  }

  async requestPayout(/* ... */) { this.assertPayoutsEnabled(); /* existing */ }
  async processPayouts(/* ... */) { this.assertPayoutsEnabled(); /* existing */ }
  async submit(/* ... */) { this.assertPayoutsEnabled(); /* existing tx submission */ }
  // BullMQ processor (§18.2 step 5-8) calls submit()/processPayouts(), so it inherits the check.
}

// ── apps/api/src/token/token.controller.ts (delta) ──
// PayoutsEnabledGuard LAST so 401/403 win over 503 (no switch-state leak to unauthorized callers).
@UseGuards(JwtAuthGuard, PayoutsEnabledGuard)
@Post('request-payout')
requestPayout(/* ... */) { /* existing */ }

@UseGuards(JwtAuthGuard, RolesGuard, PayoutsEnabledGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Post('admin/process-payouts')
processPayouts(/* ... */) { /* existing */ }
```

**Spec patch:**
- **§8 Environment** — in the ```env``` block under "# Crypto", immediately after `CREDIT_TO_NRN_WEI=...`, add:
  ```
  # Global token payout kill-switch. .env.example = local/testnet profile => true.
  # Config factory default is false (fail-closed); production deploys omit/leave false.
  TOKEN_PAYOUTS_ENABLED=true
  ```
  Add prose: "`.env.example` is the canonical **local/testnet** profile; its `true` matches the §23 local-demo intent. The `registerAs('token')` factory and production posture default to **false (fail-closed)** — an absent/invalid value disables payouts."
- **§23 Seed** — replace the literal `TOKEN_PAYOUTS_ENABLED=true for local/testnet only` with: `TOKEN_PAYOUTS_ENABLED  # default false (§8 config factory, fail-closed); set true ONLY for local/testnet (as .env.example does)`. §8 + the config factory are the single source of truth; §23 documents the local override — no bare conflicting default left floating.
- **§10.8 Wallet / Crypto** — annotate routes:
  ```
  POST /api/token/request-payout        # PayoutsEnabledGuard (503 TOKEN_PAYOUTS_DISABLED if off)
  POST /api/token/admin/process-payouts # PayoutsEnabledGuard (503 TOKEN_PAYOUTS_DISABLED if off)
  ```
  Add: "When `TOKEN_PAYOUTS_ENABLED` is false these two endpoints return 503; `GET /api/token/config` returns `payoutsEnabled:false` so the UI disables payout actions. All other token routes remain available. Guard order: auth/role guards first, `PayoutsEnabledGuard` last (401/403 take precedence over 503)."
- **§19.2 Product controls** — change `- token payout can be disabled globally` to: `- token payout can be disabled globally via TOKEN_PAYOUTS_ENABLED (§8); PRIMARY enforcement is TokenPayoutService.assertPayoutsEnabled() before any tx submission (covers HTTP + BullMQ/cron workers); PayoutsEnabledGuard adds an HTTP-layer 503 fast-fail on /api/token/request-payout and /api/token/admin/process-payouts; fail-closed default = disabled`.
- **§18.1 TokenConfigService** — add: "exposes `payoutsEnabled` (global kill-switch, snapshotted at boot) and includes it in `GET /api/token/config` without dropping tokenAddress/vaultAddress/abi/chainId. `PayoutsEnabledGuard` rejects payout mutations with 503 when the switch is off; `TokenPayoutService` re-checks before every tx submission so queued/cron workers honor it too."

**Known limitations:** (1) Switch is read at boot via `registerAs`, so toggling requires an API restart — acceptable for a single-VPS MVP global kill-switch; back with a DB/Redis flag if hot-toggle is ever needed. (2) `asBool` treats only explicit truthy strings as enabled, so a typo (e.g. `ture`) fails closed — intended safe direction, verifiable via `GET /api/token/config` `payoutsEnabled`. (3) Global layer only — per-user `PAYOUT_BLOCKED` / `ComplianceFlagService` gating remains orthogonal and must still run when the global switch is on.

---

This is a self-contained synthesis task. I have the solution and review; no repo exploration is needed since the deliverable is the corrected artifact folding in the high findings.

### G14 — Reward signer key custody

**Decision:** A single backend-held `REWARD_SIGNER_PRIVATE_KEY` as the sole `onlyOwner` signer for `ComputeRewardVault.payReward` is ACCEPTABLE for Phase B (local Hardhat) and Phase C (Sepolia) ONLY, and is forbidden on mainnet by a **fail-closed** code gate plus a process gate. No contract redesign for testnet — `Ownable` already lets ownership transfer to a Gnosis Safe with zero `payReward` changes. Folding in both high review findings, the signer path now **defaults deny**: the signer is constructed only for an explicit testnet-chainId allowlist, and the configured `chainId` is cross-checked against the chain the RPC actually serves before any `Wallet` is returned. Testnet controls (binding): dedicated low-balance hot key, env-injected on the VPS at mode 600, never committed/imaged, never logged or serialized (only the derived signer ADDRESS may be logged), loaded once at boot, refuses to boot under `NODE_ENV=production` or a non-allowlisted chain. Phase D (mainnet): Vault owner MUST be a Gnosis Safe N-of-M multisig (min 3-of-5, recommended 4-of-7), hardware-held keys, distinct holders across ≥2 jurisdictions, no two keys per machine; any retained backend automation uses KMS/HSM and may only PROPOSE Safe txs, never execute; rotation quarterly and on compromise/departure via Safe owner ops, logged. The network-level mainnet payout gate is enforced concretely via a `PHASE_D_PACKAGE` ComplianceRecord lookup (finding #3 resolved option (a)) plus a `MAINNET_PAYOUTS_ENABLED` flag.

**Prisma deltas:**
```
none
```
ComplianceRecord (nullable `userId`, string `type`/`status`) already supports the Phase D network-enablement gate as a row `{ type: "PHASE_D_PACKAGE", userId: null, status: "APPROVED" }`. TokenPayout/AuditLog cover payout state + rotation logging. No new model.

**Code:**
```ts
// packages/.../crypto/chain-tier.ts
// Fail-closed: the ONLY chains the reward-signer path will operate on are the
// explicitly approved testnets. Anything else (including unknown/new mainnets) is denied.
export const APPROVED_TESTNET_CHAIN_IDS = new Set<number>([31337, 11155111]); // Hardhat, Sepolia

export function isApprovedTestnet(chainId: number): boolean {
  return APPROVED_TESTNET_CHAIN_IDS.has(chainId);
}

// packages/.../crypto/reward-signer.provider.ts
import { Wallet, JsonRpcProvider } from "ethers";
import { isApprovedTestnet } from "./chain-tier";

// Single source of truth for how the reward signer is constructed.
// Default-deny: throws unless the chain is an approved testnet AND not production,
// AND the RPC actually serves the configured chainId.
export async function buildRewardSigner(cfg: {
  chainId: number;
  rpcUrl: string;
  rewardSignerPrivateKey?: string;
  nodeEnv: string;
}): Promise<Wallet> {
  // Finding #1: fail-closed allowlist — unknown/mainnet chainIds are rejected by default.
  if (cfg.nodeEnv === "production" || !isApprovedTestnet(cfg.chainId)) {
    throw new Error(
      `REWARD_SIGNER_FORBIDDEN: raw EOA signer permitted only on approved testnets ` +
        `(Phase B/C). chainId=${cfg.chainId} nodeEnv=${cfg.nodeEnv}. ` +
        `Mainnet requires a Gnosis Safe multisig owner + KMS-backed signing (Phase D).`,
    );
  }
  if (!cfg.rewardSignerPrivateKey) {
    throw new Error("REWARD_SIGNER_PRIVATE_KEY missing for testnet payouts.");
  }

  const provider = new JsonRpcProvider(cfg.rpcUrl);

  // Finding #2: tie the env gate to the REAL network — refuse if RPC serves a different chain
  // (e.g. CHAIN_ID=31337 left at default while RPC_URL points at forked/real mainnet).
  const net = await provider.getNetwork();
  if (net.chainId !== BigInt(cfg.chainId)) {
    throw new Error(
      `REWARD_SIGNER_CHAIN_MISMATCH: configured chainId=${cfg.chainId} but RPC serves ` +
        `chainId=${net.chainId}. Refusing to construct signer.`,
    );
  }

  return new Wallet(cfg.rewardSignerPrivateKey, provider);
  // NOTE: never log cfg.rewardSignerPrivateKey; log signer.address only.
}

// packages/.../compliance/compliance-flag.service.ts (excerpt)
// Finding #3 (option a): concrete network-level Phase D gate via ComplianceRecord. No migration.
async isPhaseDApproved(): Promise<boolean> {
  const rec = await this.prisma.complianceRecord.findFirst({
    where: { type: "PHASE_D_PACKAGE", userId: null, status: "APPROVED" },
  });
  return !!rec;
}

// packages/.../crypto/token-payout.service.ts (excerpt)
// submit() network-level gate — layered ON TOP of the existing per-user
// ComplianceFlagService/kycStatus block (§18.1/§18.2). Default-deny on any non-testnet chain.
async submit(payout: /* ... */ { chainId: number }): Promise<void> {
  const onApprovedTestnet = isApprovedTestnet(payout.chainId);
  const mainnetEnabled =
    process.env.MAINNET_PAYOUTS_ENABLED === "true" &&
    (await this.compliance.isPhaseDApproved());

  if (!onApprovedTestnet && !mainnetEnabled) {
    throw new ForbiddenException("MAINNET_PAYOUTS_DISABLED_PENDING_PHASE_D");
  }
  // ... existing per-user compliance + kyc checks + payReward submission ...
}

// Config redaction (defense-in-depth; do NOT rely on it as the only protection — prefer
// loading the key straight into the signer and discarding it from the config object).
export function redactSecrets<T extends Record<string, unknown>>(c: T): T {
  const SECRET_KEYS = ["REWARD_SIGNER_PRIVATE_KEY", "AI_OPENAI_COMPATIBLE_API_KEY", "SEED_ADMIN_PASSWORD"];
  const out = { ...c };
  for (const k of SECRET_KEYS) if (k in out) (out as Record<string, unknown>)[k] = "***REDACTED***";
  return out;
}
```

**Spec patch:**

§20.3 (Crypto security) — REPLACE the two reward-signer bullets:
```
- reward signer private key only backend secret in MVP
- production reward signer must be multisig/secure custody
```
WITH:
```
- reward signer private key is the ONLY backend signing secret, permitted in Phase B (Hardhat) and Phase C (Sepolia) ONLY
- dedicated low-balance hot key; env on VPS, file mode 600, never committed, never in images
- never logged or serialized (redacted at config loader; absent from AuditLog, traces, TokenConfigService, health/config endpoints); only signer ADDRESS may be logged
- signer path is DEFAULT-DENY: built only for an explicit approved-testnet chainId allowlist {31337, 11155111}; any unknown/mainnet chainId or NODE_ENV=production refuses to boot
- buildRewardSigner cross-checks configured chainId against provider.getNetwork(); a mismatch (RPC serving a different chain) fails closed
- Phase D (mainnet) reward signer MUST be a Gnosis Safe N-of-M multisig as ComputeRewardVault owner (min 3-of-5; recommended 4-of-7), hardware signers, distinct holders/jurisdictions, no two keys per machine
- any retained backend automation uses KMS/HSM (never plaintext, non-exportable) and may only PROPOSE Safe txs, never unilaterally execute
- signer rotation quarterly and on compromise/departure via Safe owner add/remove/changeThreshold, logged to AuditLog + compliance package
```

§16.6 (MVP payout model) — append Phase D:
```
Phase D:
  production NRN with legal/token/compliance package
  PRECONDITIONS (all required, gate is structural + fail-closed):
    - ComputeRewardVault ownership transferred to a Gnosis Safe multisig
      (deploy/migration asserts provider.getCode(owner) !== "0x" — owner is a contract account)
    - N-of-M signer policy live (min 3-of-5) with hardware-held keys
    - ComplianceRecord {type:"PHASE_D_PACKAGE", userId:null, status:"APPROVED"} present
    - MAINNET_PAYOUTS_ENABLED=true
  Until ALL preconditions clear, TokenPayoutService.submit() rejects any non-approved-testnet chainId
  (default-deny: the absence of a positive testnet match OR mainnet-enable+Phase-D-approved blocks).
```

§18 — add §18.4 'Reward signer custody':
```
## 18.4 Reward signer custody
Testnet (Phase B/C): single REWARD_SIGNER_PRIVATE_KEY held by TokenPayoutService via buildRewardSigner();
  EOA signer; fail-closed allowlist {31337,11155111}; chainId↔RPC cross-check; redacted everywhere.
Production (Phase D): Safe multisig owner; backend may only propose; execution needs threshold human signers; KMS/HSM for any backend key.
Gate: TokenPayoutService.submit() blocks any chainId that is not an approved testnet UNLESS
  MAINNET_PAYOUTS_ENABLED && ComplianceFlagService.isPhaseDApproved() (ComplianceRecord PHASE_D_PACKAGE row) —
  layered on top of the existing per-user ComplianceFlagService/kycStatus block (§18.1, §18.2).
```

§8 env block (~line 526) — annotate:
```
REWARD_SIGNER_PRIVATE_KEY=   # testnet only (Phase B/C); mode 600, never logged; signer path is default-deny by chainId; Phase D uses Safe multisig
MAINNET_PAYOUTS_ENABLED=false   # Phase D network-level payout gate; also requires APPROVED PHASE_D_PACKAGE ComplianceRecord
```

**Known limitations:** (1, low) The Phase-D owner-is-contract assertion (`provider.getCode(owner) !== "0x"`) lives in the deploy/migration script, not in runtime backend code — it must be wired into the migration task. (2, low) `redactSecrets` is allowlist-based, so a future secret env var added without updating `SECRET_KEYS` could leak in a config dump; mitigated by preferring to load the key directly into the signer and never placing it in the serialized config object. (3, process not code) The Phase-D human-custody plan — key ceremony, rotation cadence, jurisdiction spread, Safe UI/contract risk, signer-collusion at threshold — is multisig-inherent and audited via the broader Phase D compliance package, out of G14 scope.

---

### G15 — GPU/worker job isolation on community hardware

**Decision:** CONFIRM + HARDEN. Grid jobs are vetted `neurion/*` images run over DATA, never user-supplied code: the agent resolves the image from the local JOB_TYPES registry to a pinned `@sha256` digest, validates the running image's `RepoDigest` against that pin before exec, never builds, and never pulls an image named in the payload. The `containerImage` field in `job.assign` (§10.5) is downgraded to ADVISORY — the agent accepts it only if it exactly equals the registry pin, else refuses. Residual threats are (a) a vetted image heavier than declared, (b) a buggy/compromised vetted image attempting escape/exhaustion, (c) malicious input data (e.g. a crafted PDF for `embedding.v1`). These are hardened with a compiled-in, non-configurable Docker run-flag contract (config can only TIGHTEN via `min()`), a cooperative+monitored GPU memory control, and a deterministic kill→inspect→purge→report teardown. A killed job is `RETRYING` (re-dispatched, not charged) and never reaches VERIFIED, so no `NODE_REWARD` is ever written — breaches surface through the existing G1 reputation/SUSPEND machinery with no new Prisma model.

**Prisma deltas:** none.

Breaches reuse G1: a killed job never reaches VERIFIED, so no `CreditLedger` `NODE_REWARD` row is written and no clawback is needed. The backend maps `reason=NODE_LIMIT_BREACH` → `JobStatus.RETRYING` and writes a `JobEvent(type="NODE_LIMIT_BREACH", data={breach})` + `AuditLog(action="NODE_JOB_KILLED")` using existing models; the G1 reputation EWMA reads these existing `JobEvent`/`AuditLog` rows. No new model, enum value, or column. (A first-class `NodeSecurityEvent` model is explicitly OUT of scope for MVP.)

**Code:**
```ts
// node-agent (Go-flavored pseudocode, faithful to the real flag set). Package: internal/runner
//
// Worker contract (§13.1): entrypoint reads /job/input.json (0444), writes /job/output.json.
// The per-job temp dir is bound at /job (NOT /work). rootfs is --read-only; /job bind is rw,nosuid,nodev,noexec.

type ResolvedLimits struct {
	CPUs        float64 // --cpus
	MemoryBytes int64   // --memory (== --memory-swap, swap disabled)
	PidsLimit   int64   // --pids-limit
	GPUMemBytes int64   // SOFT: cooperative worker cap; HARD enforcement = nvidia-smi monitor-kill
	WallSeconds int     // min(job, maxJobSeconds)
	NofileSoft  int64
	NprocSoft   int64
	TmpfsBytes  int64
}

// ResolvedLimits = min(compiled-in safety floor, nodeConfig.limits). Config can only tighten.

func (r *Runner) buildRunArgs(job Job, img ResolvedImage, lim ResolvedLimits) []string {
	args := []string{
		"run", "--name", containerName(job.ID), // NO --rm: keep state inspectable post-exit (OOMKilled/ExitCode)

		// ---- privilege / arbitrary-code hardening ----
		"--read-only",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--security-opt", "seccomp=" + r.seccompProfileFor(img), // CPU: default-deny; GPU: CUDA-vetted profile
		"--user", "65534:65534",
		"--ipc", "none",
		"--cgroupns", "private",

		// ---- network: hard default-deny (see networkFlag) ----
	}
	args = append(args, networkFlag(job.Type, r.cfg)...)

	args = append(args,
		// ---- writable surfaces (bounded) ----
		fmt.Sprintf("--mount=type=tmpfs,destination=/tmp,tmpfs-size=%d,tmpfs-mode=1777", lim.TmpfsBytes),
		// single host bind = per-job temp dir mounted at /job (matches §13.1 worker contract); 0700 on host
		fmt.Sprintf("--mount=type=bind,source=%s,destination=/job,bind-propagation=private", job.TempDir),

		// ---- CPU / RAM / PID ----
		"--cpus", fmt.Sprintf("%.2f", lim.CPUs),
		"--memory", strconv.FormatInt(lim.MemoryBytes, 10),
		"--memory-swap", strconv.FormatInt(lim.MemoryBytes, 10),
		"--memory-swappiness", "0",
		"--pids-limit", strconv.FormatInt(lim.PidsLimit, 10),

		// ---- ulimits ----
		"--ulimit", fmt.Sprintf("nofile=%d:%d", lim.NofileSoft, lim.NofileSoft),
		"--ulimit", fmt.Sprintf("nproc=%d:%d", lim.NprocSoft, lim.NprocSoft),
		"--ulimit", "core=0:0",
		"--ulimit", fmt.Sprintf("fsize=%d:%d", lim.TmpfsBytes, lim.TmpfsBytes),
	)

	if r.cfg.AllowGpu && img.NeedsGPU {
		// Pin ONE device by UUID; never "all". Note: this selects the device, it does NOT partition VRAM.
		args = append(args, "--gpus", fmt.Sprintf("device=%s", r.gpuDeviceUUID))
		// GPU memory cap is COOPERATIVE: the worker entrypoint calls
		// torch.cuda.set_per_process_memory_fraction() from NEURION_GPU_MEM_LIMIT_BYTES.
		// HARD enforcement is the nvidia-smi monitor-kill below (NOT max_split_size_mb, which only
		// tunes allocator fragmentation and does NOT cap VRAM).
		args = append(args,
			"-e", fmt.Sprintf("CUDA_VISIBLE_DEVICES=%s", r.gpuVisibleIndex),
			"-e", fmt.Sprintf("NEURION_GPU_MEM_LIMIT_BYTES=%d", lim.GPUMemBytes),
			// GPU workers need a writable NVIDIA cache; provide as bounded tmpfs (rootfs is --read-only)
			"--mount=type=tmpfs,destination=/tmp/.nv,tmpfs-size=67108864",
			"-e", "__GL_SHADER_DISK_CACHE_PATH=/tmp/.nv",
		)
	}

	args = append(args, img.RepoDigest)        // digest-pinned, pre-validated == registry pin
	args = append(args, job.EntrypointArgs...) // DATA only -> fixed §13.1 entrypoint
	return args
}

func (r *Runner) runWithEnforcement(ctx context.Context, job Job, img ResolvedImage, lim ResolvedLimits) (Result, error) {
	// Pre-flight: allowlist (prefix neurion/* AND exact pinned digest for this jobType).
	if !r.allowlist.IsPinned(img.RepoDigest, job.Type) {
		return r.fail(job, "IMAGE_NOT_ALLOWLISTED", img.RepoDigest)
	}
	// Pre-flight GPU headroom: refuse if free VRAM < required, shrinking the monitor overage window.
	if r.cfg.AllowGpu && img.NeedsGPU && r.freeGpuMemBytes() < lim.GPUMemBytes {
		return r.fail(job, "GPU_INSUFFICIENT_VRAM", "")
	}

	cname := containerName(job.ID)
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(lim.WallSeconds)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(runCtx, "docker", r.buildRunArgs(job, img, lim)...)
	if err := cmd.Start(); err != nil {
		return r.fail(job, "CONTAINER_START_FAILED", err.Error())
	}
	mon := r.startBreachMonitor(runCtx, cname, lim) // nvidia-smi 2s poll: GPU mem/temp/power
	waitErr := make(chan error, 1)
	go func() { waitErr <- cmd.Wait() }()

	reason := ""
	select {
	case b := <-mon.Breach:
		reason = b // "GPU_MEM" | "GPU_TEMP" | "POWER"
	case <-runCtx.Done():
		reason = "WALL_TIMEOUT"
	case err := <-waitErr:
		if err != nil {
			reason = "WORKER_NONZERO_EXIT" // refined by inspect below
		}
	}

	// Strict teardown order: kill-if-running -> INSPECT (no --rm, so state survives) -> remove -> purge.
	r.docker.Kill(cname, "SIGKILL") // no-op if already exited
	st := r.docker.Inspect(cname)   // captures OOMKilled, ExitCode reliably (container not yet removed)
	if reason == "" && st.OOMKilled {
		reason = "OOM"
	} else if reason == "WORKER_NONZERO_EXIT" && st.OOMKilled {
		reason = "OOM"
	} else if reason == "WORKER_NONZERO_EXIT" && isPidsOrUlimit(st) {
		reason = "PIDS_OR_ULIMIT"
	}
	out := []byte(nil)
	if reason == "" {
		out = r.collectOutput(job.TempDir) // /job/output.json on host == job.TempDir
	}
	r.docker.ForceRemove(cname)
	_ = os.RemoveAll(job.TempDir)

	if reason != "" {
		r.reportBreach(job, reason) // idempotent WS report (see below)
		return Result{Status: "FAILED_NODE_LIMIT", Reason: reason}, nil // backend -> RETRYING, re-dispatch
	}
	return Result{Status: "DONE", Output: out}, nil // -> G1 optimistic-deliver + tiered verify
}

// Idempotent breach report: backend dedups on (jobId,nodeId,reason) and ignores reports for jobs
// no longer ASSIGNED to this node, preventing reputation double-penalty. Agent retries until acked.
func (r *Runner) reportBreach(job Job, reason string) {
	r.ws.SendUntilAcked(ControlMsg{
		Type:    "job.failed",
		JobID:   job.ID,
		NodeID:  r.nodeID,
		Reason:  "NODE_LIMIT_BREACH", // additive field on job.failed (§10.5)
		Detail:  map[string]any{"breach": reason, "ts": time.Now().UTC()},
		// errorMessage also carries "NODE_LIMIT_BREACH:<reason>" for backward-compat consumers
	})
}

// Hard default-deny network. Community nodes get NO egress by default.
func networkFlag(jobType string, cfg Config) []string {
	for _, t := range cfg.Security.AllowNetworkForJobTypes { // empty for COMMUNITY trustLevel
		if t == jobType {
			return []string{"--network", "neurion-egress"} // egress-filtered bridge, DNS/IP allowlist to model+MinIO only
		}
	}
	return []string{"--network", "none"}
}
```

**Spec patch:**

- **§10.5 (WS protocol)** — `job.assign.containerImage` is now ADVISORY: the agent independently resolves `REGISTRY[jobType].image` (pinned `@sha256`) and accepts the payload value only if it exactly equals the pin, else refuses. Extend `job.failed` additively with optional `reason: string` and `detail: Json` (non-breaking; `errorMessage` also carries `"NODE_LIMIT_BREACH:<breach>"` for old consumers). Backend maps `reason==NODE_LIMIT_BREACH` → `JobStatus.RETRYING` + writes `JobEvent(type="NODE_LIMIT_BREACH")` + `AuditLog(action="NODE_JOB_KILLED")`; dedups on `(jobId,nodeId,reason)` and ignores reports for jobs not currently ASSIGNED to that node. This is an explicit protocol change (not "none").
- **§13.2 (worker images)** — replace mutable tag refs (`neurion/embedding-worker:0.1.0`) with pinned `neurion/<type>@sha256:<digest>`; the JOB_TYPES registry (G4) is the single source of truth for the pin. Worker mount point is `/job` (input.json 0444, output.json written by worker), consistent with §13.1.
- **§12.2 (local config)** — extend `limits:` with TIGHTENING-ONLY hard caps; default `allowNetworkForJobTypes: []` for COMMUNITY trustLevel:
```yaml
  limits:
    maxJobSeconds: 1800
    maxCpus: 4                 # --cpus
    maxMemoryMb: 8192          # --memory == --memory-swap (swap off)
    maxPidsPerJob: 512         # --pids-limit
    maxGpuMemoryMb: 8192       # cooperative worker cap; enforced by nvidia-smi monitor-kill
    maxOpenFiles: 1024         # ulimit nofile
    maxProcsPerJob: 256        # ulimit nproc
    tmpfsMb: 1024              # tmpfs /tmp size
  security:
    allowNetworkForJobTypes: []   # empty default; egress only via neurion-egress allowlist when set
```
Note: "Caps are TIGHTENING-ONLY — agent applies `min(compiled-in floor, configured value)`. Worker image, network mode, capability set, and seccomp profile are NEVER read from config; they are fixed by §20.1."
- **§20.1 (node security)** — replace the CPU/RAM/time line and Docker-sandbox lines with the mandatory agent-enforced run-flag contract: digest-pinned `neurion/*` allowlist with pre-exec `RepoDigest` validation (agent never builds/pulls payload images); jobs are vetted images over DATA passed as argv/env to the fixed §13.1 entrypoint; mandatory flags `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `seccomp=<profile>`, `--user 65534:65534`, `--ipc none`, `--cgroupns private`, `--network none` by default; resource caps `--cpus/--memory(==--memory-swap, swap off)/--pids-limit/ulimits`; GPU `--gpus device=<single UUID>` (selects device only, does NOT partition VRAM) + cooperative `set_per_process_memory_fraction` + nvidia-smi 2s monitor-kill + dispatch-time VRAM headroom pre-flight; bounded tmpfs `/tmp` and a single per-job `/job` bind (0700, nosuid/nodev/noexec); GPU workers get a vetted relaxation set (writable tmpfs `/tmp/.nv`, NVIDIA device nodes, CUDA-compatible seccomp profile) that MUST be CI-tested against each image before allowlisting; network only via egress-filtered `neurion-egress` bridge (DNS/IP allowlist), never host net; on ANY breach (OOM/wall-timeout/pids/ulimit/GPU mem/temp/power): SIGKILL → inspect → force-remove → purge job temp → idempotent `job.failed(NODE_LIMIT_BREACH)` → backend `RETRYING` + `JobEvent` + `AuditLog(NODE_JOB_KILLED)`; job re-dispatched, NO optimistic credit claimed. Cross-ref: "Repeated NODE_LIMIT_BREACH events feed the G1 reputation/SUSPEND pipeline via existing JobEvent/AuditLog rows; no new persistence."

**Known limitations:** (1) GPU VRAM is NOT hard-isolated pre-MIG — only cooperative per-process fraction + nvidia-smi 2s monitor-kill + dispatch-time headroom check; a ~2s spike window remains (bounded by maxConcurrentJobs=1), true isolation needs MIG/MPS unavailable on consumer GPUs. (2) Default-deny seccomp + cap-drop + non-root can break CUDA paths — GPU profile MUST be CI-validated against each `neurion/*` image as a gate in the image-vetting/allowlist step. (3) `--read-only` assumes vetted entrypoints write only to `/tmp`, `/tmp/.nv`, and `/job`; any image needing more must be re-vetted, not granted looser flags. (4) Input-data exploits (malicious PDF) are contained, not prevented; a kernel/driver 0-day could still escape — accepted for MVP single-VPS + G2 community plaintext gating. (5) Breach detection trusts the host Docker/NVIDIA stack; the node operator is inside their own trust boundary — backend-side defense remains the G1 verifier + clawback, which this spec does not weaken.

---
