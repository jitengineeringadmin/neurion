# G2 — Prompt Privacy / Confidential Routing

**Status:** decided (2026-06-24) · **Spec ref:** `NEURION_SPEC_Codex_IT_EN_v1.1.md` §3.1, §9.3 (L760), §11.3, §14.4 · **Owner:** Giacomo Rossi

Resolves gap **G2**: in the FAST lane the user's raw prompt + streamed response is sent to a warm node to run inference. If that node is COMMUNITY (a stranger's PC/GPU), the operator is the inference endpoint and can read, log, retain, exfiltrate, and tamper. The spec let PUBLIC chat route to community nodes with no confidentiality control — a GDPR (Art. 9 / Art. 25), MiCAR and AI-Act gap. Decided via diverse-prior panel (privacy-legal / product-latency / security-arch) + red-team + adversarial review (caught 3 blockers + 3 high).

---

## 1. Threat model (malicious/curious COMMUNITY node operator)

| Id | Threat | Addressed by |
|----|--------|--------------|
| TP1 | Logs/reads plaintext prompt + response | structural: community excluded above PUBLIC |
| TP2 | Harvests PII / secrets / credentials | classifier hard-block + verified-default floor |
| TP3 | Retains conversation, builds profile, resells | ephemeral-context attestation + no community plaintext by default |
| TP4 | Tampers with response (injection/ads/scam) | buffer-until-verified + node signature; community = untrusted |
| TP5 | Silent model swap | attestation `boundModelHash`; G1 sampling for correctness |
| TP6 | Metadata leakage (who/when/side channels) | opaque session handle, identity-free envelope, no raw flags to client |

**Hard fact:** against a malicious *endpoint* operator, transport TLS does NOT help — the operator terminates TLS and sees plaintext. True confidentiality on an untrusted node needs either confidential-compute/TEE attestation (mostly absent on consumer RTX) or simply **not sending confidential plaintext to untrusted nodes**. The design picks the latter as the floor.

---

## 2. Decisions

```
GP1 = verified_default
      ChatConversation.privacyLevel defaults to VERIFIED_ONLY.
      A COMMUNITY (stranger) node is structurally absent from the allow-set for default chat.
      PUBLIC-on-community is an explicit, separately-consented, anonymous-only open tier.

GP2 = hybrid
      Confidentiality is a property of WHERE plaintext flows. Anything above PUBLIC is
      physically dispatchable ONLY to VERIFIED/ENTERPRISE/INTERNAL or a server-verified
      TEE-attested node. tls_only + no-log promises from anonymous operators are rejected
      as non-Art.32 controls.

GP3 = auto_classify_escalate
      A cheap, fail-safe, pre-dispatch classifier can only RAISE the privacy floor
      (never lower, never block, never slow). ADVISORY — not the boundary. A hard
      Art.9/credential second pass ejects COMMUNITY even on the consented open tier.
```

**Core principle:** confidentiality must be a property of *where plaintext flows*, never of an anonymous operator's promise or a classifier's recall. The architectural floor (VERIFIED_ONLY default + hard trust-set filter) is the real control; the classifier is advisory and can only fail *up*.

What stays on COMMUNITY: (1) async GRID jobs (governed by [G1](verification-g1.md)); (2) an explicit, separately-consented, **anonymous-only** open PUBLIC tier. Default chat stays fast on warm VERIFIED/ENTERPRISE/INTERNAL/FALLBACK pools — *fast is a property of warm realtime pools, not of trust level*.

---

## 3. Data flow + lawful basis (regulator-facing)

1. Every chat message resolves a **server-side effective privacy** = `floor(VERIFIED_ONLY) ⊔ userChoice ⊔ classifier`, monotonic-up; the request's claimed privacy is never trusted directly.
2. Effective privacy maps to a **hard trust-set**; COMMUNITY is in it **iff** effective == PUBLIC **and** a live, non-revoked `OpenTierConsent` exists; Art.9/credential hits force `VERIFIED_ONLY` regardless of consent.
3. Default/confidential chat streams from warm VERIFIED/ENTERPRISE/INTERNAL pools; with no warm trusted node it **escalates lane → FALLBACK (INTERNAL)** — never downgrades privacy for latency.
4. **Lawful basis:** default trusted path = Art.6(1)(b) + Art.28 DPAs on VERIFIED/ENTERPRISE + INTERNAL infra; open tier = Art.6(1)(a) explicit consent, anonymous sessions only, no account-linkable identifiers egressed, Art.9 hard-blocked from community. Art.25 by-default = schema VERIFIED_ONLY default + boot assertion. Routing auditable per-message for MiCAR/AI-Act.

---

## 4. Prisma deltas

```prisma
enum ConfidentialComputeType { NONE NVIDIA_CC AMD_SEV_SNP INTEL_SGX INTEL_TDX }
enum AttestationStatus { PENDING VERIFIED REJECTED REVOKED EXPIRED }
enum RouteReason {
  USER_SELECTED  CLASSIFIER_ESCALATED  SERVER_HARD_BLOCK
  CLASSIFIER_FAILSAFE  NO_WARM_TRUSTED_NODE  POLICY_DEFAULT
}

// ── BLOCKER FIX (B1): REAL migration, not a comment. ──
// ChatConversation delta:
//   privacyLevel      PrivacyLevel @default(VERIFIED_ONLY)   // was @default(PUBLIC) at spec L760
//   openTierConsentId String?
//   openTierConsent   OpenTierConsent? @relation(fields:[openTierConsentId], references:[id])
//
// Migration SQL (hand-authored alongside `prisma migrate`):
//   ALTER TABLE "ChatConversation" ALTER COLUMN "privacyLevel" SET DEFAULT 'VERIFIED_ONLY';
//   ALTER TABLE "ChatConversation"
//     ADD CONSTRAINT chk_public_requires_consent
//     CHECK ("privacyLevel" <> 'PUBLIC' OR "openTierConsentId" IS NOT NULL);

model NodeConfidentialityProfile {
  id        String @id @default(cuid())
  nodeId    String @unique
  node      Node   @relation(fields: [nodeId], references: [id], onDelete: Cascade)
  trustLevel NodeTrustLevel
  ccType            ConfidentialComputeType @default(NONE)
  attestationStatus AttestationStatus       @default(PENDING)
  attestationId     String?
  attestation       NodeAttestation?        @relation("ActiveAttestation", fields: [attestationId], references: [id])
  ephemeralContextOnly Boolean @default(false)
  noRetentionAgreed    Boolean @default(false)
  acceptedAgreementId  String?
  acceptedAgreement    NodeOperatorAgreementAcceptance? @relation(fields: [acceptedAgreementId], references: [id])
  chatEligible Boolean @default(false)
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())
  attestations NodeAttestation[] @relation("ProfileAttestations")
  @@index([trustLevel, chatEligible])
  @@index([ccType, attestationStatus])
}

model NodeAttestation {
  id      String @id @default(cuid())
  nodeId  String
  node    Node   @relation(fields: [nodeId], references: [id], onDelete: Cascade)
  profileId String?
  profile   NodeConfidentialityProfile? @relation("ProfileAttestations", fields: [profileId], references: [id])
  ccType ConfidentialComputeType
  status AttestationStatus @default(PENDING)
  quoteRaw        Bytes
  measurement     String   // expected enclave/launch measurement (hex)
  boundModelHash  String?  // FIX TP5: measurement bound to the loaded model
  nonce           String   // anti-replay challenge WE issued (consumed once)
  nonceConsumedAt DateTime?
  verifierVendor  String?
  rejectionReason String?
  verifiedAt DateTime?
  expiresAt  DateTime?      // hard freshness ceiling, evaluated at SEND time (H1 TOCTOU)
  createdAt DateTime @default(now())
  activeFor NodeConfidentialityProfile[] @relation("ActiveAttestation")
  @@index([nodeId, status])
  @@index([expiresAt])
  @@unique([nonce])         // a quote-nonce can never be replayed
}

model NodeOperatorAgreement {
  id        String   @id @default(cuid())
  version   String   @unique
  bodyHash  String
  effective DateTime @default(now())
  createdAt DateTime @default(now())
  acceptances NodeOperatorAgreementAcceptance[]
}

model NodeOperatorAgreementAcceptance {
  id          String   @id @default(cuid())
  nodeId      String
  node        Node     @relation(fields: [nodeId], references: [id], onDelete: Cascade)
  operatorId  String
  agreementId String
  agreement   NodeOperatorAgreement @relation(fields: [agreementId], references: [id])
  acceptedAt  DateTime @default(now())
  ipHash      String
  userAgent   String?
  signature   String?
  profiles    NodeConfidentialityProfile[]
  @@unique([nodeId, agreementId])
  @@index([operatorId])
}

model ChatMessageRoute {
  id        String @id @default(cuid())
  messageId String @unique
  message   ChatMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)
  effectivePrivacy PrivacyLevel
  requestedPrivacy PrivacyLevel
  routeReason      RouteReason
  lane             Lane
  servedTrustLevel NodeTrustLevel
  servedNodeId     String?
  servedViaTee     Boolean @default(false)
  ccTypeUsed       ConfidentialComputeType @default(NONE)
  // FIX TP6: do NOT persist raw Art.9/secret flags as plaintext columns.
  escalated            Boolean @default(false)
  classifierCategory   String  @default("NONE") // coarse: NONE | PII | SENSITIVE | FAILSAFE
  classifierDetailsEnc Bytes?                    // app-encrypted; pruned by retention job
  classifierDetailsTtl DateTime?
  responseTrusted  Boolean @default(true)
  responseDigest   String?  // AUDIT digest only — explicitly NOT an anti-tamper proof
  nodeSignature    String?  // node-signed output (TP4); null when unsigned/community
  integrityChecked Boolean @default(false)
  createdAt DateTime @default(now())
  @@index([effectivePrivacy, servedTrustLevel])
  @@index([routeReason])
}

model OpenTierConsent {
  id         String   @id @default(cuid())
  // FIX: open tier is ANONYMOUS-session only; sessionId, not a user account.
  sessionId  String   // opaque anonymous session; NO userId linkage
  acceptedAt DateTime @default(now())
  bannerHash String
  revokedAt  DateTime?
  createdAt  DateTime @default(now())
  @@index([sessionId, revokedAt])
}
```

---

## 5. Classifier + hard trust-set filter

```typescript
// privacy/privacy.types.ts
export const PRIVACY_ORDER: Record<PrivacyLevel, number> = {
  PUBLIC: 0, EU_ONLY: 1, VERIFIED_ONLY: 2, ENTERPRISE_ONLY: 3, INTERNAL_ONLY: 4,
};
export const maxPrivacy = (a: PrivacyLevel, b: PrivacyLevel): PrivacyLevel =>
  PRIVACY_ORDER[a] >= PRIVACY_ORDER[b] ? a : b;
export const CHAT_PRIVACY_FLOOR: PrivacyLevel = 'VERIFIED_ONLY';
```

```typescript
// privacy/trust-filter.ts
/**
 * THE HARD FILTER. INVARIANT: COMMUNITY ∈ result ⟺ effective === 'PUBLIC'.
 * FIX (M-EU_ONLY): EU_ONLY and trust are ORTHOGONAL (regional filter); trust exclusion
 * below PUBLIC is driven by the VERIFIED_ONLY chat floor, not by EU_ONLY. Region is
 * enforced separately in isRegionEligible.
 */
export function allowedTrustLevels(effective: PrivacyLevel): Set<NodeTrustLevel> {
  switch (effective) {
    case 'PUBLIC':          return new Set(['COMMUNITY', 'VERIFIED', 'ENTERPRISE', 'INTERNAL']);
    case 'EU_ONLY':         return new Set(['COMMUNITY', 'VERIFIED', 'ENTERPRISE', 'INTERNAL']); // region applied orthogonally
    case 'VERIFIED_ONLY':   return new Set(['VERIFIED', 'ENTERPRISE', 'INTERNAL']);              // COMMUNITY excluded
    case 'ENTERPRISE_ONLY': return new Set(['ENTERPRISE', 'INTERNAL']);
    case 'INTERNAL_ONLY':   return new Set(['INTERNAL']);
    default: { const _never: never = effective; return new Set(['INTERNAL']); } // fail CLOSED
  }
}
export const REGIONAL_LEVELS: ReadonlySet<PrivacyLevel> = new Set(['EU_ONLY']);
export function isRegionEligible(node: { region: string }, effective: PrivacyLevel): boolean {
  if (!REGIONAL_LEVELS.has(effective)) return true;
  return node.region === 'EU';
}
```

```typescript
// privacy/privacy-classifier.service.ts — FAIL-SAFE (B2)
export interface ClassificationResult {
  category: 'NONE' | 'PII' | 'SENSITIVE' | 'FAILSAFE';
  flags: string[]; escalateTo: PrivacyLevel; hardTrustedOnly: boolean; failedSafe: boolean;
}
/** Most-restrictive default used on ANY error/timeout. NEVER PUBLIC. */
const FAILSAFE: ClassificationResult = {
  category: 'FAILSAFE', flags: ['CLASSIFIER_FAILSAFE'],
  escalateTo: 'VERIFIED_ONLY', hardTrustedOnly: true, failedSafe: true,
};

@Injectable()
export class PrivacyClassifierService {
  private readonly log = new Logger(PrivacyClassifierService.name);
  private static readonly MAX_LEN = 16_000; // input cap kills ReDoS blow-up

  private static readonly SECRET = [
    /sk-[A-Za-z0-9]{20,64}/, /(?:AKIA|ASIA)[0-9A-Z]{16}/, /gh[pousr]_[A-Za-z0-9]{30,80}/,
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
    /eyJ[A-Za-z0-9_-]{8,256}\.[A-Za-z0-9_-]{8,256}\.[A-Za-z0-9_-]{8,256}/,
    /password\s{0,4}[:=]\s{0,4}\S{1,128}/i,
  ];
  private static readonly ART9 = [
    /(diagnos|prescrib|psychiatr|HIV|cancer|pregnan|disab)/i,
    /(IBAN|swift|card\s{0,2}number|cvv|ssn|social security)/i,
    /(catholic|muslim|jewish|union member|sexual orientation|biometric)/i,
  ];
  private static readonly PII = [
    /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/,
    /\+?\d[\d ().-]{6,18}\d/,   // bounded length — no catastrophic backtrack
  ];

  classify(textRaw: string): ClassificationResult {
    try {
      const text = (textRaw ?? '').slice(0, PrivacyClassifierService.MAX_LEN);
      const flags: string[] = []; let escalateTo: PrivacyLevel = 'PUBLIC';
      let hardTrustedOnly = false; let category: ClassificationResult['category'] = 'NONE';
      if (PrivacyClassifierService.SECRET.some((r) => r.test(text))) {
        flags.push('SECRET'); hardTrustedOnly = true; category = 'SENSITIVE';
        escalateTo = maxPrivacy(escalateTo, 'VERIFIED_ONLY');
      }
      if (PrivacyClassifierService.ART9.some((r) => r.test(text))) {
        flags.push('ART9'); hardTrustedOnly = true; category = 'SENSITIVE';
        escalateTo = maxPrivacy(escalateTo, 'VERIFIED_ONLY');
      }
      if (PrivacyClassifierService.PII.some((r) => r.test(text))) {
        flags.push('PII'); if (category === 'NONE') category = 'PII';
        escalateTo = maxPrivacy(escalateTo, 'VERIFIED_ONLY');
      }
      return { category, flags, escalateTo, hardTrustedOnly, failedSafe: false };
    } catch (err) {
      this.log.error(`classifier failed -> failing safe UP: ${String(err)}`);
      return FAILSAFE; // any exception => most restrictive, never PUBLIC.
    }
  }

  /** Async/ML drop-in must also fail safe: bounded time, error/timeout => FAILSAFE. */
  async classifyBounded(text: string, ms = 40): Promise<ClassificationResult> {
    try {
      return await Promise.race([
        Promise.resolve(this.classify(text)),
        new Promise<ClassificationResult>((res) => setTimeout(() => res(FAILSAFE), ms)),
      ]);
    } catch { return FAILSAFE; }
  }
}
```

---

## 6. FAST-lane dispatch — fail-SAFE, single entry point (B1, B3, H1)

```typescript
// router/effective-privacy.ts
export function resolveEffectivePrivacy(
  conversationPrivacy: PrivacyLevel,
  hasLiveOpenTierConsent: boolean,        // live = exists AND not revoked
  cls: ClassificationResult,
): EffectivePrivacy {
  // 1) gp1 floor unless a LIVE open-tier consent exists.
  let level = hasLiveOpenTierConsent
    ? conversationPrivacy
    : maxPrivacy(conversationPrivacy, CHAT_PRIVACY_FLOOR);
  let reason: EffectivePrivacy['reason'] =
    level === conversationPrivacy ? 'USER_SELECTED' : 'POLICY_DEFAULT';
  // 2) Classifier may only RAISE.
  const raised = maxPrivacy(level, cls.escalateTo);
  if (raised !== level) { level = raised; reason = cls.failedSafe ? 'CLASSIFIER_FAILSAFE' : 'CLASSIFIER_ESCALATED'; }
  // 3) Hard pass: Art.9 / credentials / failsafe NEVER egress to community.
  if (cls.hardTrustedOnly) { level = maxPrivacy(level, 'VERIFIED_ONLY'); reason = cls.failedSafe ? 'CLASSIFIER_FAILSAFE' : 'SERVER_HARD_BLOCK'; }
  return { level, reason, hardTrustedOnly: cls.hardTrustedOnly, category: cls.category };
}
```

```typescript
// router/ai-router.service.ts — THE ONLY routing entry point (FAST + GRID). Replaces spec §11.3.
@Injectable()
export class AiRouterService {
  constructor(private readonly classifier: PrivacyClassifierService,
              private readonly attestation: AttestationService) {}

  async plan(input: {
    prompt: string; requestedPrivacy: PrivacyLevel; hasLiveOpenTierConsent: boolean;
    warmNodes: WarmNode[]; grid?: boolean;
    confirmEligibleAtSend: (nodeId: string) => Promise<boolean>; // H1: TOCTOU re-check
  }): Promise<DispatchPlan> {
    const cls = await this.classifier.classifyBounded(input.prompt);
    const eff = resolveEffectivePrivacy(input.requestedPrivacy, input.hasLiveOpenTierConsent, cls);
    const allowed = allowedTrustLevels(eff.level);

    const candidates: WarmNode[] = [];
    for (const n of input.warmNodes) {
      if (!n.isWarm || !n.chatEligible) continue;
      if (!isRegionEligible(n, eff.level)) continue;
      if (allowed.has(n.trustLevel)) { candidates.push(n); continue; }
      if (await this.attestation.teeOverrideAllows(n.id, n.ccType, n.loadedModelHash, eff.level)) candidates.push(n);
    }
    candidates.sort((a, b) => TRUST_RANK[b.trustLevel] - TRUST_RANK[a.trustLevel]);

    for (const chosen of candidates) {
      if (!(await input.confirmEligibleAtSend(chosen.id))) continue; // H1: expired/revoked/superseded
      const isCommunity = chosen.trustLevel === 'COMMUNITY';
      const viaTee = chosen.ccType !== 'NONE'
        && await this.attestation.teeOverrideAllows(chosen.id, chosen.ccType, chosen.loadedModelHash, eff.level);
      return {
        lane: input.grid ? 'GRID' : 'FAST', nodeId: chosen.id,
        effectivePrivacy: eff.level, servedTrustLevel: chosen.trustLevel,
        routeReason: eff.reason as RouteReason,
        responseTrusted: !isCommunity,   // TP4: community structurally untrusted
        servedViaTee: viaTee, category: eff.category,
      };
    }
    // No eligible warm trusted node => ESCALATE lane to FALLBACK, never downgrade privacy.
    return {
      lane: 'FALLBACK', nodeId: null, effectivePrivacy: eff.level, servedTrustLevel: 'INTERNAL',
      routeReason: 'NO_WARM_TRUSTED_NODE', responseTrusted: true, servedViaTee: false, category: eff.category,
    };
  }
}
```

```typescript
// bootstrap/privacy-invariants.ts — B1: fail boot if the floor is wrong.
export async function assertPrivacyInvariants(app: INestApplicationContext): Promise<void> {
  const prisma = app.get(PrismaService);
  const [{ column_default }] = await prisma.$queryRawUnsafe<any[]>(
    `SELECT column_default FROM information_schema.columns
     WHERE table_name='ChatConversation' AND column_name='privacyLevel'`);
  if (!String(column_default ?? '').includes('VERIFIED_ONLY'))
    throw new Error(`BOOT ABORT: ChatConversation.privacyLevel default is '${column_default}', expected VERIFIED_ONLY`);
  const leaks = await prisma.$queryRawUnsafe<any[]>(
    `SELECT count(*)::int AS n FROM "ChatConversation"
     WHERE "privacyLevel"='PUBLIC' AND "openTierConsentId" IS NULL`);
  if (leaks[0]?.n > 0) throw new Error(`BOOT ABORT: ${leaks[0].n} PUBLIC conversations without OpenTierConsent`);
}
```

---

## 7. TEE gate, response integrity, eligibility, badge (H2, H3, TP4, TP6)

```typescript
// privacy/attestation.service.ts — H2: server-verified TEE gate (no self-reported booleans)
@Injectable()
export class AttestationService {
  constructor(private readonly prisma: PrismaService) {}
  async teeOverrideAllows(nodeId: string, ccTypeClaimed: string, loadedModelHash: string, effective: PrivacyLevel): Promise<boolean> {
    if (effective === 'INTERNAL_ONLY') return false;       // never delegate off-box
    if (ccTypeClaimed === 'NONE') return false;            // no TEE => no override
    const att = await this.prisma.nodeAttestation.findFirst({
      where: { nodeId, status: 'VERIFIED', ccType: ccTypeClaimed as any }, orderBy: { verifiedAt: 'desc' } });
    if (!att) return false;
    if (!att.expiresAt || att.expiresAt.getTime() <= Date.now()) return false; // fresh NOW
    if (!att.nonceConsumedAt) return false;                                     // nonce actually used
    if (att.boundModelHash && att.boundModelHash !== loadedModelHash) return false; // TP5
    return true;
  }
}
```

```typescript
// router/response-integrity.service.ts — H3/TP4: buffer-until-verified for community
@Injectable()
export class ResponseIntegrityService {
  bufferCommunityResponse(opts: { declaredModelHash: string; nodePubKeyPem?: string; nodeSig?: string }) {
    const hash = createHash('sha256'); const findings: string[] = []; const buf: string[] = [];
    const TAMPER = [/click here|buy now|visit https?:\/\//i, /ignore (?:all )?previous instructions/i, /as an AI from \w+/i];
    return {
      onChunk: (c: string) => { buf.push(c); hash.update(c); for (const r of TAMPER) if (r.test(c)) findings.push(r.source); },
      finalize: () => {
        const body = buf.join(''); const digest = hash.digest('hex'); let sigOk = false;
        if (opts.nodePubKeyPem && opts.nodeSig) {
          try { sigOk = createVerify('SHA256').update(body).end().verify(opts.nodePubKeyPem, opts.nodeSig, 'base64'); } catch { sigOk = false; }
        }
        return { body, responseDigest: digest, nodeSignatureValid: sigOk, integrityChecked: true,
                 trusted: sigOk && findings.length === 0, tamperFindings: findings };
      },
    };
  }
  streamTrustedResponse() {
    const hash = createHash('sha256');
    return { onChunk: (c: string) => hash.update(c), finalize: () => ({ responseDigest: hash.digest('hex'), trusted: true }) };
  }
  toNodeEnvelope(prompt: string, model: string) {
    return { handle: randomUUID(), model, prompt }; // TP6: no userId/email/conversationId/ip/timestamp
  }
}
```

```typescript
// nodes/chat-eligibility.service.ts — H1: atomic send-time re-check
@Injectable()
export class ChatEligibilityService {
  constructor(private readonly prisma: PrismaService) {}
  private freshAttestation(p: { attestationStatus: string; attestation?: { expiresAt: Date | null } | null }): boolean {
    return p.attestationStatus === 'VERIFIED' && !!p.attestation?.expiresAt && p.attestation.expiresAt.getTime() > Date.now();
  }
  async confirmEligibleAtSend(nodeId: string): Promise<boolean> {
    const p = await this.prisma.nodeConfidentialityProfile.findUnique({ where: { nodeId }, include: { attestation: true, acceptedAgreement: true } });
    if (!p || !p.chatEligible || !p.ephemeralContextOnly || !p.noRetentionAgreed) return false;
    const current = await this.prisma.nodeOperatorAgreement.findFirstOrThrow({ orderBy: { effective: 'desc' } });
    if (p.acceptedAgreement?.agreementId !== current.id) return false;            // agreement superseded
    if (p.trustLevel !== 'COMMUNITY' && p.ccType !== 'NONE' && !this.freshAttestation(p as any)) return false; // expired/revoked
    return true;
  }
}
```

Privacy badge (TP6 — no raw special-category flags to the client): returns coarse `protectionApplied: 'none' | 'sensitive_protected'`, `trustIndicator: 'trusted' | 'open_tier' | 'tee_attested'`, `responseTrusted`, `escalated`, `effectivePrivacy`, `lane`. Never ships `['ART9_HEALTH']`-style flags.

---

## 8. Known limitations (medium/low residuals)

- **Open-tier non-Art.9 PII (by design):** PII a user does not recognize as PII can still egress to an anonymous COMMUNITY node on the consented open tier. Mitigated: open tier = **anonymous sessions only** (no account linkage in `OpenTierConsent.sessionId`), hard Art.9/credential second pass, blunt "assume a stranger can read this" banner (`bannerHash`). No Art.28 DPA exists for community open-tier processing — hence the anonymity requirement.
- **Classifier recall (advisory by design):** regex misses paraphrased/obfuscated PII. Deliberately **not the boundary** — VERIFIED_ONLY floor + hard filter are. Residual bounded to text a user explicitly placed on the open tier; even there it fails *up*.
- **Response heuristics:** the three tamper regexes catch only crude injection/ads; subtle wrong answers pass. Real assurance = buffer-until-verified + node signature; absent a signature, community responses surface as `trusted:false`, never authoritative. Future: spot-re-run a sample of community responses on trusted infra.
- **EU_ONLY semantics:** reconciled as **regional-only**; trust exclusion comes from the VERIFIED_ONLY chat floor, not EU_ONLY. If product later wants EU_ONLY to exclude COMMUNITY, that must be an explicit spec change (§14.4).
- **Classifier-detail retention:** sensitive detail stored only encrypted (`classifierDetailsEnc`) with TTL, pruned by a retention job; route table persists only coarse `classifierCategory`.
- **TEE operational surface:** revocation latency + nonce issue/consume flow must be operated correctly; `confirmEligibleAtSend` bounds but does not eliminate a sub-second TOCTOU window. Acceptable given FALLBACK-on-failure default.

---

## 9. Implementation files

```
prisma/schema.prisma                          (deltas §4 + hand-authored migration: VERIFIED_ONLY default + PUBLIC-requires-consent CHECK)
src/privacy/{privacy.types,trust-filter,privacy-classifier.service,attestation.service}.ts
src/router/{effective-privacy,ai-router.service,response-integrity.service}.ts
src/nodes/chat-eligibility.service.ts
src/chat/privacy-badge.dto.ts
src/bootstrap/privacy-invariants.ts
src/privacy/__tests__/floor.spec.ts
```

Method: diverse-prior panel (privacy-legal / product-latency / security-arch) → red-team cross-attack → adversarial review (3 blockers + 3 high) → finalize. Decision record in memory `g2-privacy-decision`. Related: [G1 verification](verification-g1.md).
```
