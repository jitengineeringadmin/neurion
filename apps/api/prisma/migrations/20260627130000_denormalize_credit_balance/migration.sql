-- Denormalize the credit balance onto User (O(1) reads instead of SUM(ledger)
-- on every chat). Kept in sync atomically by CreditsService.spend/grant.
ALTER TABLE "User" ADD COLUMN "creditBalance" INTEGER NOT NULL DEFAULT 0;

-- Backfill from the append-only ledger so existing balances are preserved.
UPDATE "User"
SET "creditBalance" = COALESCE(
  (SELECT SUM("amount") FROM "CreditLedger" WHERE "CreditLedger"."userId" = "User"."id"),
  0
);
