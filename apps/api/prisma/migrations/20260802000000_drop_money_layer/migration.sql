-- Remove the money layer.
--
-- Neurion is becoming a peer-to-peer sharing network, so there is no token, no
-- payout, no treasury and no wallet. Credits stay: they were never money, only a
-- resource quota, and the rest of the app depends on them.
--
-- Written by hand rather than generated. `prisma migrate dev` needs a shadow
-- database, and on Windows the embedded cluster is created WIN1252, so an emoji
-- in an older migration cannot be replayed into it. `migrate deploy` applies
-- this without a shadow database.
--
-- Nothing here can lose non-money data: these three tables only ever held
-- payouts, wallet nonces and emission counters. CreditLedger and
-- User."creditBalance" are untouched.
--
-- Job."nrnPayoutEligible" is deliberately NOT dropped. Despite the name it
-- currently feeds health.verifiedJobs on the public status page; renaming it is
-- a separate change with its own call sites.

-- The FK side first: TokenPayout references User.
DROP TABLE IF EXISTS "TokenPayout";
DROP TYPE IF EXISTS "PayoutStatus";

DROP TABLE IF EXISTS "WalletNonce";
DROP TABLE IF EXISTS "EmissionSchedule";

-- User: the wallet address, the KYC state and the compliance payout hold. The
-- only reader of payoutHold lived in the payout service.
ALTER TABLE "User" DROP COLUMN IF EXISTS "walletAddress";
ALTER TABLE "User" DROP COLUMN IF EXISTS "kycStatus";
ALTER TABLE "User" DROP COLUMN IF EXISTS "payoutHold";
DROP TYPE IF EXISTS "KycStatus";

-- OwnerReputation: two columns with no readers anywhere in the API.
ALTER TABLE "OwnerReputation" DROP COLUMN IF EXISTS "lifetimePayoutCredits";
ALTER TABLE "OwnerReputation" DROP COLUMN IF EXISTS "payoutHold";
