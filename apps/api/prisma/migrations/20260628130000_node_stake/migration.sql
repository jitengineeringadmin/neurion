-- Registration bond (sybil cost): credits locked at register, refunded on
-- PROBATION graduation, forfeited on pre-graduation fraud.
ALTER TABLE "ComputeNode" ADD COLUMN IF NOT EXISTS "stakeCredits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ComputeNode" ADD COLUMN IF NOT EXISTS "stakeRefunded" BOOLEAN NOT NULL DEFAULT false;
