> **DRAFT — not legal advice.** Generated skeleton for legal review (Agent 12). Reflects controls implemented in code.

# KYC / AML Operating Model

- Payouts below KYC_PAYOUT_THRESHOLD_CREDITS: no KYC (utility, low value).
- Payouts at/above threshold: require KYC_APPROVED (enforced in TokenPayoutService).
- Blocked/rejected status (PAYOUT_BLOCKED, KYC_REJECTED) and admin payoutHold stop payouts.
- Suspicious reward/velocity patterns open a ComplianceRecord (sybil controls, G5).
- All payout actions write an append-only AuditLog.
- KYC performed via a CASP partner (provider abstraction; see casp-partner-integration.md).
