> **DRAFT — not legal advice.** Generated skeleton for legal review (Agent 12). Reflects controls implemented in code.

# CASP Partner Integration

Neurion does not operate as a CASP in MVP. A regulated partner handles KYC and any fiat on/off-ramp.

## Interface
`CaspPartnerProvider`: createKycSession, getKycStatus, createBuyOrder, getOrderStatus.
MVP uses MockCaspPartnerProvider. Production binds a licensed CASP. No internal exchange in MVP.
