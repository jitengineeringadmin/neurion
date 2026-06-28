-- Add a PROCESSING state so payout dispatch can atomically claim a PENDING row
-- (prevents double-submit + double-refund under concurrent processPayouts).
ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'PROCESSING' BEFORE 'SUBMITTED';
