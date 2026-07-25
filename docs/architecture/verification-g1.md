# G1 — Distributed Compute Verification

**Status:** decided (2026-06-24) · **Spec ref:** `NEURION_SPEC_Codex_IT_EN_v1.1.md` §8, §14, §15 · **Owner:** Giacomo Rossi

Resolves gap **G1**: prove a COMMUNITY node actually performed the assigned AI compute honestly before paying reward (credits + NRN). Decided via diverse-prior panel (fraud / UX / ops) + red-team + adversarial build review.

---

## 1. Threat model

| Id | Cheat | Caught by |
|----|-------|-----------|
| T1 | Garbage output (random bytes) | L1 sanity |
| T2 | Cache replay (return prior identical result) | golden rotation + re-exec |
| T3 | Model swap (run cheaper/smaller model) | L2 cosine/WER re-exec |
| T4 | Partial work (transcribe 10%, pad rest) | L1 plausibility + L2 |
| T5 | Null/timeout (DoS, not profit) | scheduler timeout → FAILED |
| T6 | Sybil/collusion (fake nodes vouch each other) | trusted-only verifier (structural) |

Reward = credits + NRN ⇒ cheating = theft of platform value + EU MiCAR financial-crime surface.

---

## 2. Architecture — optimistic delivery + tiered async verification

```
node returns output
  → L1 SANITY (every job, ms cost)
        fail → FAILED, no reward, reputation down, user refund
        pass → COMPLETED, result delivered to USER immediately (fast UX)
  → sampling decision (reputation-weighted)
        not sampled → VERIFIED-by-trust (no reputation gain), reward per D1
        sampled     → L2 DEEP on TRUSTED executor only (never community peer)
              pass → VERIFIED, reputation↑, reward released
              fail → FAILED, SUSPEND node, retro-audit, clawback, user refund
```

- **L1 SANITY** — cheap deterministic shape/plausibility on every job. Gate for fast delivery.
- **L2 DEEP** — re-execution or golden-task (ringer), on a sampled subset, run **only** on a trusted executor. This is the collusion firewall (T6): no code path lets a community peer produce the reference.
- **L3 REPUTATION** — EWMA per node, gates reward multiplier, sample rate, premium/private-job access, NRN eligibility. New nodes start in probation (100% verified) then earn trust.
- **Float gotcha** — deterministic jobs (embedding/ocr) yield different low-order float bits across heterogeneous hardware/BLAS ⇒ **never hash-compare**; compare in vector space (cosine / normalized-edit-distance).

Per-type: `echo.v1` exact · `embedding.v1` sanity(dim,finite,non-zero) + cosine≥0.999 re-exec · `transcription.v1` sanity(lang, words/sec vs duration) + golden WER<0.15 / GPU re-exec · `ocr.v1` sanity + normalized diff · `realtime.chat` sanity(firstTokenMs/tok-sec bounds) + async 👎 feedback.

---

## 3. Decisions

```
D1 = HYBRID
     Grant reward credits at COMPLETED only if:
        node out of probation
        AND reputation EWMA >= 0.85
        AND rewardCredits < 25 (highValueThreshold)
        AND outstandingOptimisticCredits + reward <= cap (200)
     else STRICT (credits unlock only at VERIFIED).
     INVARIANTS (always, regardless of D1):
        - user credit SPEND charged immediately at submit
        - NRN token payout strictly post-VERIFIED

D2 = { pBase: 0.15, pFloor: 0.03, probationJobs: 30, pHighValue: 1.0, highValueThreshold: 25 }

D3 = BOTH_TIERED
     fallback provider  -> cheap deterministic re-exec (embedding cosine, ocr diff, echo)
     dedicated GPU node -> version-pinned whisper ground truth (transcription = crown jewel)
     gpu->fallback proxy only behind explicit flag, marks verification provisional, withholds NRN.
```

**Why (best worst-case, not best average):**
- **D1 hybrid** — optimistic-pure worst case = bust-out (cheat → optimistic credits → spend → exit before async verify = realized loss + laundering). strict-pure removes it but over-claims "no clawback" (optimistic user delivery already exists). Hybrid: optimistic only where exposure is bounded (high-rep, low-value, capped); strict everywhere risk is real.
- **D2** — `highValueThreshold=25` anchored to real reward table (image=25; transcription/chat aggregate) so the forced high-value branch actually fires (at 100 it was a dead branch — caught by 2/3 proposals). `pHighValue=1.0` = verify-before-pay on every rich job. `probationJobs=30` bounds early bust-out without punitive onboarding. `pFloor=0.03` = permanent spot-check tail.
- **D3** — fallback can't faithfully reproduce whisper ⇒ node fingerprints the ringer and cheats real audio (T3/T4) on the highest-NRN-value job. Version-pinned GPU is the only real guard. Cost bounded: add GPU only when transcription volume/value justifies.

---

## 4. Prisma deltas

```prisma
enum VerificationMethod  { SANITY_ONLY  REEXEC  GOLDEN  FEEDBACK }
enum VerificationOutcome { PASS  FAIL  PENDING  SKIPPED }

enum CreditLedgerReason {
  USER_SPEND
  USER_REFUND            // refund user when deep-verify fails after L1 delivery
  NODE_REWARD            // positive: optimistic or post-verify reward grant
  NODE_REWARD_CLAWBACK   // negative: deep-verify failed after optimistic grant
}

enum NodeStatus { ACTIVE  PROBATION  SUSPENDED }   // SUSPENDED on any deep FAIL, pending audit

model JobVerification {
  id           String              @id @default(cuid())
  jobId        String              @unique          // idempotency key for the whole lifecycle
  job          Job                 @relation(fields: [jobId], references: [id])
  jobType      String
  sanityPassed Boolean
  sampled      Boolean             @default(false)
  method       VerificationMethod
  outcome      VerificationOutcome @default(PENDING)
  score        Float?
  threshold    Float?
  executorRef  String?                              // "fallback:embed" | "gpu:whisper-v3" — never a peer
  provisional  Boolean             @default(false)  // true if verified via degraded gpu->fallback proxy
  goldenTaskId String?
  goldenTask   GoldenTask?         @relation(fields: [goldenTaskId], references: [id])
  detail       Json?
  createdAt    DateTime            @default(now())
  resolvedAt   DateTime?
  @@index([jobType, outcome])
}

model GoldenTask {
  id            String   @id @default(cuid())
  jobType       String
  input         Json
  expected      Json
  active        Boolean  @default(true)
  usageCount    Int      @default(0)
  lastUsedAt    DateTime?
  createdAt     DateTime @default(now())
  verifications JobVerification[]
  @@index([jobType, active])
}

model ComputeNode {
  // ... existing fields ...
  reputation                   Float      @default(0.50)
  verifiedJobCount             Int        @default(0)   // counts ONLY real deep-verify passes
  status                       NodeStatus @default(PROBATION)
  inProbation                  Boolean    @default(true)
  outstandingOptimisticCredits Int        @default(0)   // >= 0 invariant enforced in service
  lifetimeUnverifiedCredits    Int        @default(0)   // feeds pFloor scaling
  lastVerifiedAt               DateTime?
  @@index([reputation])
}

model Job {
  // ... existing fields ...
  rewardCredits         Int
  userSpendCredits      Int             // charged at submit; basis for USER_REFUND on deep FAIL
  grantedOptimistically Boolean   @default(false) // reward credits made spendable at COMPLETED
  rewardPaidAt          DateTime?                  // non-null once reward ledger row committed
  nrnPayoutEligible     Boolean   @default(false)  // flips true ONLY post-VERIFIED
  verification          JobVerification?
}

model CreditLedger {
  id        String             @id @default(cuid())
  accountId String
  amount    Int                // signed; append-only, never UPDATEd
  reason    CreditLedgerReason
  jobId     String?
  createdAt DateTime           @default(now())
  @@unique([jobId, reason])    // duplicate grant/clawback/refund inserts fail atomically
}
```

---

## 5. Verifier interfaces + reference verifiers

```typescript
// verifier.types.ts
export interface SanityResult { ok: boolean; reason?: string; }
export interface DeepResult { pass: boolean; score: number; threshold: number; detail?: Record<string, unknown>; }

export interface JobVerifier<TIn = unknown, TOut = unknown> {
  readonly jobType: string;
  readonly method: VerificationMethod;
  /** L1: cheap deterministic shape/plausibility, runs on EVERY job. */
  sanity(input: TIn, output: TOut): SanityResult;
  /** L2: needs a TRUSTED reference (never a community peer's output). */
  deep(input: TIn, output: TOut, reference: TOut): DeepResult;
  /** what the trusted executor must produce for deep(). */
  referenceSpec(input: TIn): { executor: string; kind: 'REEXEC' | 'GOLDEN' };
}

export const VERIFIERS = new Map<string, JobVerifier>();
export const registerVerifier = (v: JobVerifier) => void VERIFIERS.set(v.jobType, v);
export function getVerifier(jobType: string): JobVerifier {
  const v = VERIFIERS.get(jobType);
  if (!v) throw new Error(`no verifier registered for jobType=${jobType}`);
  return v;
}
```

```typescript
// helpers.ts — FLOAT GOTCHA: never hash-compare; compare in vector space.
export const COSINE_TOLERANCE = 0.999;
export const FLOAT_EPS = 1e-6;

export const l2norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1;            // dim mismatch => guaranteed fail
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const na = l2norm(a), nb = l2norm(b);
  if (na < FLOAT_EPS || nb < FLOAT_EPS) return -1; // zero vector => degenerate
  return dot / (na * nb);                          // scale-invariant => normalization-agnostic
}
```

```typescript
// echo.v1.ts — exact match (the one type where bit-equality is valid).
export const echoVerifier: JobVerifier<{ msg: string }, { msg: string }> = {
  jobType: 'echo.v1',
  method: VerificationMethod.REEXEC,
  sanity: (i, o) => (o?.msg === i.msg ? { ok: true } : { ok: false, reason: 'echo mismatch' }),
  deep: (i, o) => ({ pass: o.msg === i.msg, score: o.msg === i.msg ? 1 : 0, threshold: 1 }),
  referenceSpec: () => ({ executor: 'fallback:echo', kind: 'REEXEC' }),
};
```

```typescript
// embedding.v1.ts
// cosine() is scale-invariant, so un-normalized models (raw E5/GTE/BERT, dimension-truncated
// openai) pass honestly. NO rigid norm==1 assertion — only loose plausibility.
interface EmbIn  { text: string; dim: number }
interface EmbOut { vector: number[] }

export const embeddingVerifier: JobVerifier<EmbIn, EmbOut> = {
  jobType: 'embedding.v1',
  method: VerificationMethod.REEXEC,
  sanity: (i, o) => {
    const v = o?.vector;
    if (!Array.isArray(v) || v.length !== i.dim) return { ok: false, reason: 'bad dim' };
    if (v.some((x) => !Number.isFinite(x)))       return { ok: false, reason: 'NaN/Inf' };  // T1
    const n = l2norm(v);
    if (n < FLOAT_EPS) return { ok: false, reason: 'zero vector' };                         // T1/T4
    if (n > 1e4)       return { ok: false, reason: 'absurd magnitude' };                    // loose only
    return { ok: true };
  },
  deep: (_i, o, ref) => {
    const c = cosine(o.vector, ref.vector);        // scale-invariant => no normalization assumption
    return { pass: c >= COSINE_TOLERANCE, score: c, threshold: COSINE_TOLERANCE }; // T3 dies here
  },
  referenceSpec: () => ({ executor: 'fallback:embed', kind: 'REEXEC' }),
};
```

---

## 6. VerificationService orchestration

```typescript
// verification.service.ts
@Injectable()
export class VerificationService {
  constructor(
    private prisma: PrismaService,
    private deepQueue: Queue,
    private ledger: LedgerService,         // append() idempotent via @@unique([jobId,reason])
    private rng: () => number = Math.random,
  ) {}

  // ── D2 constants ──
  private static readonly P_BASE = 0.15;
  private static readonly P_FLOOR = 0.03;
  private static readonly PROBATION_JOBS = 30;
  private static readonly P_HIGH_VALUE = 1.0;
  private static readonly HIGH_VALUE_THRESHOLD = 25;
  // D1 hybrid switch
  private static readonly REP_OPTIMISTIC_MIN = 0.85;
  private static readonly OPTIMISTIC_CREDIT_CAP = 200;
  // retroactive re-audit on FAIL
  private static readonly RETRO_AUDIT_LOOKBACK = 50;
  // EWMA only nudges on REAL deep passes; unsampled jobs do NOT count as a pass.
  private static readonly ALPHA = 0.1;

  /** Reputation-weighted sample rate. Lower rep / higher un-verified volume => sampled more. */
  sampleRate(node: ComputeNode, rewardCredits: number): number {
    if (node.status === 'SUSPENDED') return 1.0;
    if (node.inProbation || node.verifiedJobCount < VerificationService.PROBATION_JOBS) return 1.0;
    if (rewardCredits >= VerificationService.HIGH_VALUE_THRESHOLD) return VerificationService.P_HIGH_VALUE;
    const base = VerificationService.P_BASE * (1 - node.reputation);
    const exposureFloor = Math.min(0.30,
      VerificationService.P_FLOOR + node.lifetimeUnverifiedCredits / 20_000);
    return Math.max(exposureFloor, Math.min(VerificationService.P_BASE, base));
  }

  // ── entry point: called once per COMPLETED event ──
  async verify(job: Job, output: unknown): Promise<void> {
    const verifier = getVerifier(job.type);
    const node = await this.prisma.computeNode.findUniqueOrThrow({ where: { id: job.nodeId } });

    const sanity = verifier.sanity(job.input, output);

    // JobVerification.create is the idempotency gate. Create FIRST: a duplicate COMPLETED
    // event hits @unique(jobId) and aborts BEFORE any reward ledger write.
    let created;
    try {
      created = await this.prisma.jobVerification.create({
        data: {
          jobId: job.id, jobType: job.type, sanityPassed: sanity.ok,
          sampled: false, method: verifier.method,
          outcome: sanity.ok ? 'PENDING' : 'FAIL',
          detail: sanity.ok ? undefined : { stage: 'SANITY', reason: sanity.reason },
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return;        // duplicate delivery — already processed, no-op
      throw e;
    }

    if (!sanity.ok) { await this.failSanity(job, node, sanity.reason); return; }
    await this.deliverToUser(job, output);     // fast UX: deliver on L1 pass

    const rate = this.sampleRate(node, job.rewardCredits);
    const sampled = this.rng() < rate;

    // D1 HYBRID reward timing
    const optimisticOk =
      node.status === 'ACTIVE' &&
      !node.inProbation &&
      node.reputation >= VerificationService.REP_OPTIMISTIC_MIN &&
      job.rewardCredits < VerificationService.HIGH_VALUE_THRESHOLD &&
      node.outstandingOptimisticCredits + job.rewardCredits <= VerificationService.OPTIMISTIC_CREDIT_CAP;

    await this.prisma.jobVerification.update({
      where: { id: created.id },
      data: { sampled, outcome: sampled ? 'PENDING' : 'SKIPPED' },
    });

    if (optimisticOk) await this.grantReward(job, node, /*optimistic*/ true);

    if (!sampled) {
      // verified-by-trust, NOT a measured pass — reputation does NOT increase.
      await this.markVerified(job, node, { realDeepPass: false, optimistic: optimisticOk });
      return;
    }
    await this.deepQueue.add('deep-verify', { jobId: job.id }, { jobId: `dv:${job.id}` });
  }

  // ── called by the L2 worker after the TRUSTED executor returns ──
  async onDeepResult(jobId: string, deep: DeepResult, provisional: boolean): Promise<void> {
    // atomic terminal-state guard — second redelivery updates 0 rows and bails.
    const claimed = await this.prisma.jobVerification.updateMany({
      where: { jobId, outcome: 'PENDING' },
      data: { outcome: deep.pass ? 'PASS' : 'FAIL', score: deep.score,
              threshold: deep.threshold, provisional, resolvedAt: new Date() },
    });
    if (claimed.count === 0) return;

    const job = await this.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    const node = await this.prisma.computeNode.findUniqueOrThrow({ where: { id: job.nodeId } });

    if (deep.pass) {
      // provisional (degraded gpu->fallback) does NOT confer NRN eligibility.
      await this.markVerified(job, node, { realDeepPass: true, optimistic: job.grantedOptimistically, provisional });
    } else {
      await this.handleDeepFail(job, node);     // suspend + retro-audit + refunds
    }
  }

  // EWMA: only REAL deep-verify outcomes move reputation.
  private async bumpReputation(tx: Prisma.TransactionClient, node: ComputeNode, passed: boolean) {
    const target = passed ? 1.0 : 0.0;
    const rep = (1 - VerificationService.ALPHA) * node.reputation + VerificationService.ALPHA * target;
    const verifiedJobCount = node.verifiedJobCount + 1;   // counts ONLY measured deep-verifies
    await tx.computeNode.update({
      where: { id: node.id },
      data: { reputation: rep, verifiedJobCount,
              inProbation: verifiedJobCount < VerificationService.PROBATION_JOBS,
              lastVerifiedAt: new Date() },
    });
  }

  private async markVerified(job: Job, node: ComputeNode,
    opts: { realDeepPass: boolean; optimistic: boolean; provisional?: boolean }) {
    await this.prisma.$transaction(async (tx) => {                 // atomic
      const moved = await tx.job.updateMany({
        where: { id: job.id, status: 'COMPLETED' },
        data: { status: 'VERIFIED', nrnPayoutEligible: opts.provisional ? false : true },
      });
      if (moved.count === 0) return;                               // already transitioned

      if (opts.realDeepPass) await this.bumpReputation(tx, node, true);

      if (!opts.optimistic) {
        await this.grantRewardTx(tx, job, node, /*optimistic*/ false);  // STRICT: release escrow now
      } else {
        await this.clearOutstandingTx(tx, node, job.rewardCredits);     // optimistic already spendable
      }
      await tx.job.update({ where: { id: job.id }, data: { status: 'REWARDED' } });
    });
  }

  private async grantReward(job: Job, node: ComputeNode, optimistic: boolean) {
    await this.prisma.$transaction((tx) => this.grantRewardTx(tx, job, node, optimistic));
  }
  private async grantRewardTx(tx: Prisma.TransactionClient, job: Job, node: ComputeNode, optimistic: boolean) {
    await this.ledger.appendTx(tx, {                               // @@unique([jobId,reason]) => idempotent
      accountId: node.accountId, amount: +job.rewardCredits, reason: 'NODE_REWARD', jobId: job.id });
    await tx.job.update({
      where: { id: job.id },
      data: { grantedOptimistically: optimistic, rewardPaidAt: new Date() },   // split flags
    });
    if (optimistic) {
      await tx.computeNode.update({
        where: { id: node.id },
        data: { outstandingOptimisticCredits: { increment: job.rewardCredits },
                lifetimeUnverifiedCredits:    { increment: job.rewardCredits } },
      });
    }
  }

  // decrement outstanding ONCE and never below zero.
  private async clearOutstandingTx(tx: Prisma.TransactionClient, node: ComputeNode, amount: number) {
    const dec = Math.min(amount, node.outstandingOptimisticCredits);
    if (dec > 0) await tx.computeNode.update({
      where: { id: node.id }, data: { outstandingOptimisticCredits: { decrement: dec } } });
  }

  // deep FAIL: suspend, retro-audit, clawback, USER refund.
  private async handleDeepFail(job: Job, node: ComputeNode) {
    await this.prisma.$transaction(async (tx) => {                            // atomic
      await tx.job.updateMany({
        where: { id: job.id, status: { in: ['COMPLETED', 'VERIFIED'] } },
        data: { status: 'FAILED', nrnPayoutEligible: false } });
      await this.bumpReputation(tx, node, false);                            // EWMA -> toward 0
      await tx.computeNode.update({ where: { id: node.id }, data: { status: 'SUSPENDED' } });
      if (job.grantedOptimistically) await this.clawbackTx(tx, job, node);   // keyed on split flag
      await this.refundUserTx(tx, job);                                      // make user whole
    });
    await this.enqueueRetroAudit(node.id);
  }

  private async clawbackTx(tx: Prisma.TransactionClient, job: Job, node: ComputeNode) {
    await this.ledger.appendTx(tx, {                                          // NEGATIVE = clawback
      accountId: node.accountId, amount: -job.rewardCredits,
      reason: 'NODE_REWARD_CLAWBACK', jobId: job.id });                       // @@unique => idempotent
    await this.clearOutstandingTx(tx, node, job.rewardCredits);
    // NRN never paid (post-VERIFIED only) => nothing to claw back on-chain.
  }

  private async refundUserTx(tx: Prisma.TransactionClient, job: Job) {
    await this.ledger.appendTx(tx, {
      accountId: job.userAccountId, amount: +job.userSpendCredits,
      reason: 'USER_REFUND', jobId: job.id });                               // @@unique => once
  }

  // pull a sample of the node's recent unsampled COMPLETED jobs back through L2.
  private async enqueueRetroAudit(nodeId: string) {
    const suspects = await this.prisma.job.findMany({
      where: { nodeId, status: { in: ['VERIFIED', 'REWARDED'] },
               verification: { is: { sampled: false } } },
      orderBy: { completedAt: 'desc' },
      take: VerificationService.RETRO_AUDIT_LOOKBACK,
      select: { id: true },
    });
    for (const s of suspects) {
      await this.prisma.jobVerification.updateMany({
        where: { jobId: s.id, outcome: 'SKIPPED' }, data: { outcome: 'PENDING', sampled: true } });
      await this.deepQueue.add('deep-verify', { jobId: s.id, retro: true }, { jobId: `dv:retro:${s.id}` });
    }
  }

  private async failSanity(job: Job, node: ComputeNode, reason?: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.job.updateMany({ where: { id: job.id, status: 'COMPLETED' }, data: { status: 'FAILED' } });
      await this.bumpReputation(tx, node, false);
      await this.refundUserTx(tx, job);            // L1 never delivered usable output -> refund
    });
  }

  private async deliverToUser(_job: Job, _output: unknown) {/* push to user immediately */}
}
```

```typescript
// deep-verify.processor.ts — THE collusion firewall lives here (kills T6).
@Processor('deep-verify')
export class DeepVerifyProcessor {
  constructor(private prisma: PrismaService, private verification: VerificationService,
              private trustedExec: TrustedExecutorService) {}

  @Process('deep-verify')
  async handle(bull: BullJob<{ jobId: string }>): Promise<void> {
    const j = await this.prisma.job.findUniqueOrThrow({ where: { id: bull.data.jobId } });
    const verifier = getVerifier(j.type);
    const spec = verifier.referenceSpec(j.input);

    // COLLUSION FIREWALL: reference produced ONLY by a trusted executor (fallback:* / gpu:*)
    // or a DB golden. No path routes reference generation to a community peer => sybil ring
    // cannot vouch for itself.
    const { reference, provisional } =
      spec.kind === 'GOLDEN'
        ? { reference: await this.loadGolden(j), provisional: false }
        : await this.trustedExec.reexec(spec.executor, j.input);

    const deep = verifier.deep(j.input, j.output, reference);
    await this.verification.onDeepResult(j.id, deep, provisional); // idempotent + terminal-guarded
  }

  private async loadGolden(j: Job) {
    const g = await this.prisma.goldenTask.findFirstOrThrow({
      where: { jobType: j.type, active: true }, orderBy: { usageCount: 'asc' } });
    await this.prisma.goldenTask.update({                          // rotate to resist memorization (T2)
      where: { id: g.id }, data: { usageCount: { increment: 1 }, lastUsedAt: new Date() } });
    return g.expected;
  }
}
```

```typescript
// trusted-executor.service.ts — D3 both_tiered.
// gpu->fallback proxy is an explicit flag and returns provisional=true so the verified result
// is NOT NRN-eligible and is loudly auditable. Default OFF.
@Injectable()
export class TrustedExecutorService {
  private readonly logger = new Logger(TrustedExecutorService.name);
  constructor(private fallback: FallbackLaneProvider, private gpu: DedicatedGpuNodeClient,
              private cfg: ConfigService) {}

  async reexec(ref: string, input: unknown): Promise<{ reference: unknown; provisional: boolean }> {
    switch (ref) {
      case 'fallback:embed': return { reference: await this.fallback.embed(input), provisional: false };
      case 'fallback:ocr':   return { reference: await this.fallback.ocr(input),   provisional: false };
      case 'fallback:echo':  return { reference: input,                            provisional: false };
      case 'gpu:whisper-v3':
        if (this.gpu.available()) return { reference: await this.gpu.transcribe(input), provisional: false };
        if (this.cfg.get('ALLOW_GPU_FALLBACK_PROXY') === true) {
          this.logger.warn('PROVISIONAL transcription verify via fallback proxy (GPU down) — NRN withheld');
          return { reference: await this.fallback.transcribe(input), provisional: true };
        }
        throw new Error('gpu:whisper-v3 unavailable and proxy disabled — deep-verify deferred');
      default: throw new Error(`unknown trusted executor ${ref}`);
    }
  }
}
```

---

## 7. EV-of-cheating proof

**Case A — high-value transcription (reward ≥ 25):** `sampleRate = pHighValue = 1.0` ⇒ every job deep-verified by trusted GPU whisper before reward; D1 forces strict (≥25 disqualifies optimistic); NRN strictly post-verify. EV(cheat) = strictly negative, no realized loss. Ringer-fingerprint + model-swap caught because reference = version-pinned trusted whisper, not a peer.

**Case B — earn-trust-then-cheat, richest low-value (reward 24, rep 0.85):** `sampleRate = max(≈0.03, 0.0225) = 0.03`. Naive EV looked like `0.97×24 + 0.03×(−24) = +22.56`. The blocker-1 fixes invert it:
1. Unsampled jobs no longer raise reputation ⇒ cheating can't buy down the sample rate; the floor itself **rises** with `lifetimeUnverifiedCredits`.
2. First catch ⇒ node SUSPENDED (sampleRate→1.0) + retro-audit re-verifies last 50 unsampled, clawing back **every** failed one.
3. Optimistic capped at 200 + clawed on fail; user refunds close the externalized loss.

Expected cheats before first catch ≈ `1/0.03 ≈ 33 ≤ 50` lookback ⇒ retro recovers ~all prior cheats in the window. **Net per-job EV ≤ 0** for both richest high-value and richest low-value job types.

---

## 8. Known limitations (medium/low residuals)

- **(medium) realtime.chat feedback race** — user 👎 arrives async, after completion, so `deep()` sees `thumbsDown=undefined` and chat auto-passes at completion. Accepted per low-reward spec (~4 cr/min). Intended handling: chat verified-by-trust at completion; a later 👎 event applies retroactive reputation penalty / clawback via the same retro-audit machinery. Feedback-event consumer not yet wired.
- **(low) gpu→fallback provisional proxy** — when the GPU whisper node is down and `ALLOW_GPU_FALLBACK_PROXY=true`, transcription deep-verify degrades to fallback provider: flagged, logged, `provisional=true`, NRN withheld — but still releases reward *credits* on pass, so an attacker who forces GPU downtime gets a weaker check for credits during the outage. Mitigate: alert on sustained provisional mode; optionally defer (not pass) transcription verify while GPU unavailable.
- **(low) retro-audit window bound** — cheats older than `RETRO_AUDIT_LOOKBACK` (50) at first catch are not recovered. Tunable; raise lookback or persist a per-node cheat-suspicion marker.

---

## 9. Implementation files

```
prisma/schema.prisma                                   (deltas §4)
src/verification/verifier.types.ts
src/verification/helpers.ts
src/verification/verifiers/{echo,embedding,transcription,realtime-chat}.v1.ts
src/verification/verification.service.ts
src/verification/deep-verify.processor.ts
src/verification/trusted-executor.service.ts
```

Method: diverse-prior panel (fraud/UX/ops) → red-team cross-attack → adversarial build review (caught 3 blockers + 2 high) → finalize. Decision record in memory `g1-verification-decision`.
