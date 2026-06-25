import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobLane, JobPrivacyLevel, NodeTrustLevel, RouteReason } from '@prisma/client';
import { PrivacyClassifierService, ClassificationResult } from './privacy/classifier.service';
import { EstimatorService, Estimate } from './estimator.service';
import { ProviderResolverService } from './provider-resolver.service';
import { RealtimePoolService } from './realtime-pool.service';
import { CHAT_PRIVACY_FLOOR, maxPrivacy } from './privacy/privacy.util';
import { AiProvider } from './providers/ai-provider.interface';

export interface RoutePlan {
  lane: JobLane;
  provider: AiProvider;
  model: string;
  effectivePrivacy: JobPrivacyLevel;
  requestedPrivacy: JobPrivacyLevel;
  routeReason: RouteReason;
  servedTrustLevel: NodeTrustLevel;
  classification: ClassificationResult;
  estimate: Estimate;
  responseTrusted: boolean;
}

export interface RouteInput {
  message: string;
  conversationPrivacy: JobPrivacyLevel;
  hasLiveOpenTierConsent: boolean;
  attachmentBytes?: number;
}

/**
 * G2 + G8 router. Resolves server-side effective privacy, estimates heaviness,
 * picks a lane. MVP has no warm realtime/grid nodes wired into chat yet, so the
 * chat path always lands on FALLBACK (INTERNAL) — never downgrades privacy.
 */
@Injectable()
export class AiRouterService {
  constructor(
    private readonly classifier: PrivacyClassifierService,
    private readonly estimator: EstimatorService,
    private readonly resolver: ProviderResolverService,
    private readonly realtimePool: RealtimePoolService,
    private readonly config: ConfigService,
  ) {}

  resolveEffectivePrivacy(
    conversationPrivacy: JobPrivacyLevel,
    hasConsent: boolean,
    cls: ClassificationResult,
  ): { level: JobPrivacyLevel; reason: RouteReason } {
    let level = hasConsent ? conversationPrivacy : maxPrivacy(conversationPrivacy, CHAT_PRIVACY_FLOOR);
    let reason: RouteReason = level === conversationPrivacy ? 'USER_SELECTED' : 'POLICY_DEFAULT';
    const raised = maxPrivacy(level, cls.escalateTo);
    if (raised !== level) {
      level = raised;
      reason = cls.failedSafe ? 'CLASSIFIER_FAILSAFE' : 'CLASSIFIER_ESCALATED';
    }
    if (cls.hardTrustedOnly) {
      level = maxPrivacy(level, 'VERIFIED_ONLY');
      reason = cls.failedSafe ? 'CLASSIFIER_FAILSAFE' : 'SERVER_HARD_BLOCK';
    }
    return { level, reason };
  }

  async plan(input: RouteInput): Promise<RoutePlan> {
    const classification = this.classifier.classify(input.message);
    const estimate = this.estimator.estimate(input.message, input.attachmentBytes ?? 0);
    const eff = this.resolveEffectivePrivacy(
      input.conversationPrivacy,
      input.hasLiveOpenTierConsent,
      classification,
    );

    // FAST lane: a non-heavy request tries a warm realtime node whose trust
    // level satisfies the effective privacy (G2). COMMUNITY is excluded by the
    // VERIFIED_ONLY default unless the user opted down to PUBLIC.
    if (!estimate.isHeavy) {
      const preferredModel = this.config.get<string>('AI_DEFAULT_CHAT_MODEL') ?? 'llama3.1:8b';
      const warm = await this.realtimePool.findWarm(preferredModel, eff.level);
      if (warm) {
        return {
          lane: 'FAST',
          provider: warm.provider,
          model: warm.model,
          effectivePrivacy: eff.level,
          requestedPrivacy: input.conversationPrivacy,
          routeReason: eff.reason,
          servedTrustLevel: warm.trustLevel,
          classification,
          estimate,
          responseTrusted: warm.trustLevel !== 'COMMUNITY',
        };
      }
    }

    // No warm trusted realtime node -> trusted internal Fallback provider.
    const resolved = await this.resolver.resolveFallback();
    const reason: RouteReason =
      eff.reason === 'USER_SELECTED' || eff.reason === 'POLICY_DEFAULT' ? 'NO_WARM_TRUSTED_NODE' : eff.reason;

    return {
      lane: 'FALLBACK',
      provider: resolved.provider,
      model: resolved.model,
      effectivePrivacy: eff.level,
      requestedPrivacy: input.conversationPrivacy,
      routeReason: reason,
      servedTrustLevel: 'INTERNAL',
      classification,
      estimate,
      responseTrusted: true, // internal provider is trusted
    };
  }
}
