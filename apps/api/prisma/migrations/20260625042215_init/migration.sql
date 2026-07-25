-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'OPERATOR', 'USER', 'NODE_PROVIDER', 'COMPLIANCE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED', 'PENDING');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('KYC_NOT_REQUIRED', 'KYC_REQUIRED', 'KYC_PENDING', 'KYC_APPROVED', 'KYC_REJECTED', 'PAYOUT_BLOCKED');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('OFFLINE', 'ONLINE', 'BUSY', 'DEGRADED', 'DISABLED', 'BANNED');

-- CreateEnum
CREATE TYPE "NodeLifecycle" AS ENUM ('PROBATION', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "NodeTrustLevel" AS ENUM ('COMMUNITY', 'VERIFIED', 'ENTERPRISE', 'INTERNAL');

-- CreateEnum
CREATE TYPE "JobLane" AS ENUM ('FAST', 'GRID', 'FALLBACK');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'ASSIGNED', 'ACCEPTED', 'RUNNING', 'COMPLETED', 'VERIFIED', 'REWARDED', 'FAILED', 'RETRYING', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "JobPrivacyLevel" AS ENUM ('PUBLIC', 'EU_ONLY', 'VERIFIED_ONLY', 'ENTERPRISE_ONLY', 'INTERNAL_ONLY');

-- CreateEnum
CREATE TYPE "VerificationMethod" AS ENUM ('SANITY_ONLY', 'REEXEC', 'GOLDEN', 'FEEDBACK');

-- CreateEnum
CREATE TYPE "VerificationOutcome" AS ENUM ('PASS', 'FAIL', 'PENDING', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ChatMode" AS ENUM ('AUTO', 'FAST', 'GRID', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('SYSTEM', 'USER', 'ASSISTANT', 'TOOL');

-- CreateEnum
CREATE TYPE "ModelMode" AS ENUM ('CHAT', 'EMBEDDING', 'TRANSCRIPTION', 'IMAGE', 'OCR');

-- CreateEnum
CREATE TYPE "RealtimeSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'FAILED', 'FALLBACK_USED');

-- CreateEnum
CREATE TYPE "ConfidentialComputeType" AS ENUM ('NONE', 'NVIDIA_CC', 'AMD_SEV_SNP', 'INTEL_SGX', 'INTEL_TDX');

-- CreateEnum
CREATE TYPE "AttestationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RouteReason" AS ENUM ('USER_SELECTED', 'CLASSIFIER_ESCALATED', 'SERVER_HARD_BLOCK', 'CLASSIFIER_FAILSAFE', 'NO_WARM_TRUSTED_NODE', 'POLICY_DEFAULT');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'CANCELLED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "RegistrationChallengeKind" AS ENUM ('STAKE', 'POW');

-- CreateEnum
CREATE TYPE "RegistrationChallengeStatus" AS ENUM ('PENDING', 'SOLVED', 'CONSUMED', 'REFUNDED', 'FORFEITED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING_UPLOAD', 'STORED', 'SCANNED', 'DELETED');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "displayName" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "walletAddress" TEXT,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'KYC_NOT_REQUIRED',
    "payoutHold" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComputeNode" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nodeKeyHash" TEXT NOT NULL,
    "status" "NodeStatus" NOT NULL DEFAULT 'OFFLINE',
    "lifecycleState" "NodeLifecycle" NOT NULL DEFAULT 'PROBATION',
    "trustLevel" "NodeTrustLevel" NOT NULL DEFAULT 'COMMUNITY',
    "regionCode" TEXT,
    "os" TEXT,
    "arch" TEXT,
    "cpuModel" TEXT,
    "cpuCores" INTEGER,
    "ramMb" INTEGER,
    "gpuVendor" TEXT,
    "gpuModel" TEXT,
    "gpuMemoryMb" INTEGER,
    "dockerAvailable" BOOLEAN NOT NULL DEFAULT false,
    "nvidiaAvailable" BOOLEAN NOT NULL DEFAULT false,
    "maxConcurrentJobs" INTEGER NOT NULL DEFAULT 1,
    "supportedModes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supportedJobTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "loadedModels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "avgFirstTokenMs" INTEGER,
    "avgTokensPerSecond" DOUBLE PRECISION,
    "reputation" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "reputationScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "verifiedJobCount" INTEGER NOT NULL DEFAULT 0,
    "outstandingOptimisticCredits" INTEGER NOT NULL DEFAULT 0,
    "lifetimeUnverifiedCredits" INTEGER NOT NULL DEFAULT 0,
    "lastVerifiedAt" TIMESTAMP(3),
    "totalJobs" INTEGER NOT NULL DEFAULT 0,
    "successfulJobs" INTEGER NOT NULL DEFAULT 0,
    "failedJobs" INTEGER NOT NULL DEFAULT 0,
    "registrationIp" TEXT,
    "subnet24Hash" TEXT,
    "hardwareFingerprint" TEXT,
    "stakeChallengeId" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComputeNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeHeartbeat" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "cpuLoad" DOUBLE PRECISION,
    "ramUsedMb" INTEGER,
    "gpuLoad" DOUBLE PRECISION,
    "gpuTempC" DOUBLE PRECISION,
    "freeDiskMb" INTEGER,
    "firstTokenMs" INTEGER,
    "tokensPerSecond" DOUBLE PRECISION,
    "activeRealtimeSessions" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nodeId" TEXT,
    "chatMessageId" TEXT,
    "type" TEXT NOT NULL,
    "lane" "JobLane" NOT NULL DEFAULT 'GRID',
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "privacyLevel" "JobPrivacyLevel" NOT NULL DEFAULT 'PUBLIC',
    "inputObjectKey" TEXT,
    "outputObjectKey" TEXT,
    "inputJson" JSONB,
    "outputJson" JSONB,
    "errorMessage" TEXT,
    "costCredits" INTEGER NOT NULL DEFAULT 0,
    "rewardCredits" INTEGER NOT NULL DEFAULT 0,
    "rewardTokenWei" TEXT,
    "verificationScore" DOUBLE PRECISION,
    "grantedOptimistically" BOOLEAN NOT NULL DEFAULT false,
    "rewardPaidAt" TIMESTAMP(3),
    "nrnPayoutEligible" BOOLEAN NOT NULL DEFAULT false,
    "assignedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "rewardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobVerification" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "sanityPassed" BOOLEAN NOT NULL,
    "sampled" BOOLEAN NOT NULL DEFAULT false,
    "method" "VerificationMethod" NOT NULL,
    "outcome" "VerificationOutcome" NOT NULL DEFAULT 'PENDING',
    "score" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "executorRef" TEXT,
    "provisional" BOOLEAN NOT NULL DEFAULT false,
    "goldenTaskId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "JobVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoldenTask" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "expected" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoldenTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "mode" "ChatMode" NOT NULL DEFAULT 'AUTO',
    "privacyLevel" "JobPrivacyLevel" NOT NULL DEFAULT 'VERIFIED_ONLY',
    "openTierConsentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "laneUsed" "JobLane",
    "modelUsed" TEXT,
    "providerUsed" TEXT,
    "routingDecision" JSONB,
    "tokenUsage" JSONB,
    "costCredits" INTEGER NOT NULL DEFAULT 0,
    "linkedJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelRegistry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "modelRef" TEXT NOT NULL,
    "mode" "ModelMode" NOT NULL,
    "contextTokens" INTEGER,
    "supportsStream" BOOLEAN NOT NULL DEFAULT true,
    "supportsTools" BOOLEAN NOT NULL DEFAULT false,
    "requiresGpu" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RealtimeSession" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT,
    "userId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "RealtimeSessionStatus" NOT NULL DEFAULT 'OPEN',
    "firstTokenMs" INTEGER,
    "tokensPerSecond" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "RealtimeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeConfidentialityProfile" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "trustLevel" "NodeTrustLevel" NOT NULL,
    "ccType" "ConfidentialComputeType" NOT NULL DEFAULT 'NONE',
    "attestationStatus" "AttestationStatus" NOT NULL DEFAULT 'PENDING',
    "attestationId" TEXT,
    "ephemeralContextOnly" BOOLEAN NOT NULL DEFAULT false,
    "noRetentionAgreed" BOOLEAN NOT NULL DEFAULT false,
    "acceptedAgreementId" TEXT,
    "chatEligible" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeConfidentialityProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeAttestation" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "profileId" TEXT,
    "ccType" "ConfidentialComputeType" NOT NULL,
    "status" "AttestationStatus" NOT NULL DEFAULT 'PENDING',
    "quoteRaw" BYTEA NOT NULL,
    "measurement" TEXT NOT NULL,
    "boundModelHash" TEXT,
    "nonce" TEXT NOT NULL,
    "nonceConsumedAt" TIMESTAMP(3),
    "verifierVendor" TEXT,
    "rejectionReason" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeOperatorAgreement" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "effective" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeOperatorAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeOperatorAgreementAcceptance" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "signature" TEXT,

    CONSTRAINT "NodeOperatorAgreementAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessageRoute" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "effectivePrivacy" "JobPrivacyLevel" NOT NULL,
    "requestedPrivacy" "JobPrivacyLevel" NOT NULL,
    "routeReason" "RouteReason" NOT NULL,
    "lane" "JobLane" NOT NULL,
    "servedTrustLevel" "NodeTrustLevel" NOT NULL,
    "servedNodeId" TEXT,
    "servedViaTee" BOOLEAN NOT NULL DEFAULT false,
    "ccTypeUsed" "ConfidentialComputeType" NOT NULL DEFAULT 'NONE',
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "classifierCategory" TEXT NOT NULL DEFAULT 'NONE',
    "classifierDetailsEnc" BYTEA,
    "classifierDetailsTtl" TIMESTAMP(3),
    "responseTrusted" BOOLEAN NOT NULL DEFAULT true,
    "responseDigest" TEXT,
    "nodeSignature" TEXT,
    "integrityChecked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessageRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpenTierConsent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bannerHash" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenTierConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "jobId" TEXT,
    "chatMessageId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenPayout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT,
    "walletAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL DEFAULT 'NRN',
    "amountWei" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "txHash" TEXT,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletNonce" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletNonce_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerReputation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nodeCount" INTEGER NOT NULL DEFAULT 0,
    "effectiveReputation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ownerOutstandingOptimisticCredits" INTEGER NOT NULL DEFAULT 0,
    "lifetimeUnverifiedCredits" INTEGER NOT NULL DEFAULT 0,
    "lifetimePayoutCredits" INTEGER NOT NULL DEFAULT 0,
    "deepFailCount" INTEGER NOT NULL DEFAULT 0,
    "payoutHold" BOOLEAN NOT NULL DEFAULT false,
    "lastRegistrationAt" TIMESTAMP(3),
    "registrationsToday" INTEGER NOT NULL DEFAULT 0,
    "registrationsDayKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerReputation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationChallenge" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "RegistrationChallengeKind" NOT NULL DEFAULT 'STAKE',
    "status" "RegistrationChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "stakeCredits" INTEGER NOT NULL DEFAULT 0,
    "powChallenge" TEXT,
    "powDifficulty" INTEGER,
    "powSolution" TEXT,
    "nodeId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "RegistrationChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "maxNodesPerOwner" INTEGER NOT NULL DEFAULT 5,
    "maxNodeRegistrationsPerDay" INTEGER NOT NULL DEFAULT 3,
    "registrationStakeCredits" INTEGER NOT NULL DEFAULT 50,
    "powDifficultyBits" INTEGER NOT NULL DEFAULT 20,
    "maxOwnerOutstandingUnverifiedCredits" INTEGER NOT NULL DEFAULT 500,
    "kycPayoutThresholdCredits" INTEGER NOT NULL DEFAULT 1000,
    "maxNodesPerSubnet24" INTEGER NOT NULL DEFAULT 3,
    "maxNodesPerFingerprint" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "chatMessageId" TEXT,
    "jobId" TEXT,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmissionSchedule" (
    "id" TEXT NOT NULL,
    "epochKey" TEXT NOT NULL,
    "epochBudgetWei" TEXT NOT NULL,
    "emittedThisEpochWei" TEXT NOT NULL DEFAULT '0',
    "emittedLifetimeWei" TEXT NOT NULL DEFAULT '0',
    "poolCapWei" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmissionSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ComputeNode_stakeChallengeId_key" ON "ComputeNode"("stakeChallengeId");

-- CreateIndex
CREATE INDEX "ComputeNode_workspaceId_idx" ON "ComputeNode"("workspaceId");

-- CreateIndex
CREATE INDEX "ComputeNode_ownerUserId_idx" ON "ComputeNode"("ownerUserId");

-- CreateIndex
CREATE INDEX "ComputeNode_subnet24Hash_idx" ON "ComputeNode"("subnet24Hash");

-- CreateIndex
CREATE INDEX "ComputeNode_hardwareFingerprint_idx" ON "ComputeNode"("hardwareFingerprint");

-- CreateIndex
CREATE INDEX "NodeHeartbeat_nodeId_createdAt_idx" ON "NodeHeartbeat"("nodeId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_workspaceId_status_idx" ON "Job"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Job_userId_idx" ON "Job"("userId");

-- CreateIndex
CREATE INDEX "Job_nodeId_idx" ON "Job"("nodeId");

-- CreateIndex
CREATE INDEX "JobEvent_jobId_createdAt_idx" ON "JobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobVerification_jobId_key" ON "JobVerification"("jobId");

-- CreateIndex
CREATE INDEX "JobVerification_jobType_outcome_idx" ON "JobVerification"("jobType", "outcome");

-- CreateIndex
CREATE INDEX "GoldenTask_jobType_active_idx" ON "GoldenTask"("jobType", "active");

-- CreateIndex
CREATE INDEX "ChatConversation_workspaceId_userId_idx" ON "ChatConversation"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "RealtimeSession_nodeId_idx" ON "RealtimeSession"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeConfidentialityProfile_nodeId_key" ON "NodeConfidentialityProfile"("nodeId");

-- CreateIndex
CREATE INDEX "NodeConfidentialityProfile_trustLevel_chatEligible_idx" ON "NodeConfidentialityProfile"("trustLevel", "chatEligible");

-- CreateIndex
CREATE INDEX "NodeConfidentialityProfile_ccType_attestationStatus_idx" ON "NodeConfidentialityProfile"("ccType", "attestationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "NodeAttestation_nonce_key" ON "NodeAttestation"("nonce");

-- CreateIndex
CREATE INDEX "NodeAttestation_nodeId_status_idx" ON "NodeAttestation"("nodeId", "status");

-- CreateIndex
CREATE INDEX "NodeAttestation_expiresAt_idx" ON "NodeAttestation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NodeOperatorAgreement_version_key" ON "NodeOperatorAgreement"("version");

-- CreateIndex
CREATE INDEX "NodeOperatorAgreementAcceptance_operatorId_idx" ON "NodeOperatorAgreementAcceptance"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeOperatorAgreementAcceptance_nodeId_agreementId_key" ON "NodeOperatorAgreementAcceptance"("nodeId", "agreementId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessageRoute_messageId_key" ON "ChatMessageRoute"("messageId");

-- CreateIndex
CREATE INDEX "ChatMessageRoute_effectivePrivacy_servedTrustLevel_idx" ON "ChatMessageRoute"("effectivePrivacy", "servedTrustLevel");

-- CreateIndex
CREATE INDEX "ChatMessageRoute_routeReason_idx" ON "ChatMessageRoute"("routeReason");

-- CreateIndex
CREATE INDEX "OpenTierConsent_sessionId_revokedAt_idx" ON "OpenTierConsent"("sessionId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_idempotencyKey_key" ON "CreditLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_jobId_reason_key" ON "CreditLedger"("jobId", "reason");

-- CreateIndex
CREATE INDEX "TokenPayout_userId_status_idx" ON "TokenPayout"("userId", "status");

-- CreateIndex
CREATE INDEX "WalletNonce_address_used_idx" ON "WalletNonce"("address", "used");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ComplianceRecord_userId_idx" ON "ComplianceRecord"("userId");

-- CreateIndex
CREATE INDEX "ComplianceRecord_type_status_idx" ON "ComplianceRecord"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerReputation_userId_key" ON "OwnerReputation"("userId");

-- CreateIndex
CREATE INDEX "OwnerReputation_workspaceId_idx" ON "OwnerReputation"("workspaceId");

-- CreateIndex
CREATE INDEX "RegistrationChallenge_userId_status_idx" ON "RegistrationChallenge"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceConfig_workspaceId_key" ON "WorkspaceConfig"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_replacedById_key" ON "RefreshToken"("replacedById");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_family_idx" ON "RefreshToken"("family");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_objectKey_key" ON "Attachment"("objectKey");

-- CreateIndex
CREATE INDEX "Attachment_workspaceId_idx" ON "Attachment"("workspaceId");

-- CreateIndex
CREATE INDEX "Attachment_chatMessageId_idx" ON "Attachment"("chatMessageId");

-- CreateIndex
CREATE INDEX "Attachment_jobId_idx" ON "Attachment"("jobId");

-- CreateIndex
CREATE INDEX "Attachment_status_expiresAt_idx" ON "Attachment"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmissionSchedule_epochKey_key" ON "EmissionSchedule"("epochKey");

-- CreateIndex
CREATE INDEX "EmissionSchedule_epochKey_idx" ON "EmissionSchedule"("epochKey");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeNode" ADD CONSTRAINT "ComputeNode_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeNode" ADD CONSTRAINT "ComputeNode_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeHeartbeat" ADD CONSTRAINT "NodeHeartbeat_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "ComputeNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "ComputeNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobVerification" ADD CONSTRAINT "JobVerification_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobVerification" ADD CONSTRAINT "JobVerification_goldenTaskId_fkey" FOREIGN KEY ("goldenTaskId") REFERENCES "GoldenTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_openTierConsentId_fkey" FOREIGN KEY ("openTierConsentId") REFERENCES "OpenTierConsent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_linkedJobId_fkey" FOREIGN KEY ("linkedJobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RealtimeSession" ADD CONSTRAINT "RealtimeSession_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "ComputeNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeConfidentialityProfile" ADD CONSTRAINT "NodeConfidentialityProfile_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "ComputeNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeConfidentialityProfile" ADD CONSTRAINT "NodeConfidentialityProfile_attestationId_fkey" FOREIGN KEY ("attestationId") REFERENCES "NodeAttestation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeConfidentialityProfile" ADD CONSTRAINT "NodeConfidentialityProfile_acceptedAgreementId_fkey" FOREIGN KEY ("acceptedAgreementId") REFERENCES "NodeOperatorAgreementAcceptance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeAttestation" ADD CONSTRAINT "NodeAttestation_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "ComputeNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeAttestation" ADD CONSTRAINT "NodeAttestation_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "NodeConfidentialityProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeOperatorAgreementAcceptance" ADD CONSTRAINT "NodeOperatorAgreementAcceptance_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "ComputeNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeOperatorAgreementAcceptance" ADD CONSTRAINT "NodeOperatorAgreementAcceptance_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "NodeOperatorAgreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageRoute" ADD CONSTRAINT "ChatMessageRoute_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenPayout" ADD CONSTRAINT "TokenPayout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerReputation" ADD CONSTRAINT "OwnerReputation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerReputation" ADD CONSTRAINT "OwnerReputation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationChallenge" ADD CONSTRAINT "RegistrationChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceConfig" ADD CONSTRAINT "WorkspaceConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "RefreshToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_chatMessageId_fkey" FOREIGN KEY ("chatMessageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
