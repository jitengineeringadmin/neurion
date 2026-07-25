import { z } from 'zod';

/** Job privacy levels (mirrors Prisma JobPrivacyLevel). */
export const PrivacyLevel = z.enum([
  'PUBLIC',
  'EU_ONLY',
  'VERIFIED_ONLY',
  'ENTERPRISE_ONLY',
  'INTERNAL_ONLY',
]);
export type PrivacyLevel = z.infer<typeof PrivacyLevel>;

export const Lane = z.enum(['FAST', 'GRID', 'FALLBACK']);
export type Lane = z.infer<typeof Lane>;

export const NodeTrustLevel = z.enum(['COMMUNITY', 'VERIFIED', 'ENTERPRISE', 'INTERNAL']);
export type NodeTrustLevel = z.infer<typeof NodeTrustLevel>;

// NEURION_VERSION used to be hardcoded here and had no callers — it had already
// drifted to 1.2.0 while the product shipped 1.8.8. The version now comes from
// package.json (see apps/api/src/health/health.controller.ts).
