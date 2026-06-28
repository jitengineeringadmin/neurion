-- Real compute verification: a VERIFYING claim state (closes the double-pay race)
-- and an unverified-job counter that drives the sampling exposure floor.
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'VERIFYING' BEFORE 'VERIFIED';
ALTER TABLE "ComputeNode" ADD COLUMN IF NOT EXISTS "unverifiedJobCount" INTEGER NOT NULL DEFAULT 0;
