-- A failed payout could only be refunded from amountWei, which holds the NET.
-- The fee was therefore kept on a payout that never happened. Record what the
-- user actually paid so they can be made whole.
ALTER TABLE "TokenPayout" ADD COLUMN "grossCredits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TokenPayout" ADD COLUMN "feeCredits" INTEGER NOT NULL DEFAULT 0;

-- Marks the point after which refunding is unsafe: once the transaction is on
-- the wire it may still confirm, and refunding as well would pay out twice.
ALTER TABLE "TokenPayout" ADD COLUMN "submittedAt" TIMESTAMP(3);

-- Backfill: existing rows only ever stored the net, and no fee is recoverable
-- for them retroactively.
UPDATE "TokenPayout" SET "grossCredits" = 0 WHERE "grossCredits" IS NULL;
