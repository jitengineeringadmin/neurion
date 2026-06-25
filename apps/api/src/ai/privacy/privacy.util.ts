import { JobPrivacyLevel, NodeTrustLevel } from '@prisma/client';

export const PRIVACY_ORDER: Record<JobPrivacyLevel, number> = {
  PUBLIC: 0,
  EU_ONLY: 1,
  VERIFIED_ONLY: 2,
  ENTERPRISE_ONLY: 3,
  INTERNAL_ONLY: 4,
};

export const maxPrivacy = (a: JobPrivacyLevel, b: JobPrivacyLevel): JobPrivacyLevel =>
  PRIVACY_ORDER[a] >= PRIVACY_ORDER[b] ? a : b;

export const CHAT_PRIVACY_FLOOR: JobPrivacyLevel = 'VERIFIED_ONLY';

/**
 * G2 hard filter. INVARIANT: COMMUNITY in result <=> effective === 'PUBLIC'.
 * EU_ONLY is regional-only; trust exclusion below PUBLIC comes from the floor.
 */
export function allowedTrustLevels(effective: JobPrivacyLevel): Set<NodeTrustLevel> {
  switch (effective) {
    case 'PUBLIC':
    case 'EU_ONLY':
      return new Set(['COMMUNITY', 'VERIFIED', 'ENTERPRISE', 'INTERNAL']);
    case 'VERIFIED_ONLY':
      return new Set(['VERIFIED', 'ENTERPRISE', 'INTERNAL']);
    case 'ENTERPRISE_ONLY':
      return new Set(['ENTERPRISE', 'INTERNAL']);
    case 'INTERNAL_ONLY':
      return new Set(['INTERNAL']);
    default: {
      const _never: never = effective;
      return new Set<NodeTrustLevel>(['INTERNAL']); // fail closed
    }
  }
}
