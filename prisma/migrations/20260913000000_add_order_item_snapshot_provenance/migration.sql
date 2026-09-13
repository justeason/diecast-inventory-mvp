-- 21C: OrderItem.snapshotProvenance — closed internal values ('sale_time',
-- 'intake_declared', 'legacy_model_only'). Answers "where did these physical
-- facts come from," never a confidence score. Nullable — legacy reconstruction
-- (intake_declared / legacy_model_only) is a separate one-time application-level
-- script (scripts/normalizeHistoricalSales.ts), never guessed in SQL.
ALTER TABLE "OrderItem" ADD COLUMN "snapshotProvenance" TEXT;

-- Conservative, purely mechanical backfill: an existing OrderItem that ALREADY
-- carries all three 21B physical-fact fields (marketVariantId,
-- snapshotPackagingType, snapshotCondition) can only have gotten there via the
-- 21B+ live OrderItem-creation path (orders.ts), which always writes all three
-- together from the authoritative ItemInstance at creation time. No other
-- write path in the codebase ever populates these fields. This is a pure
-- structural fact about existing data, not a guess — never touches a row whose
-- snapshotProvenance is already non-null.
UPDATE "OrderItem"
SET "snapshotProvenance" = 'sale_time'
WHERE "snapshotProvenance" IS NULL
  AND "marketVariantId" IS NOT NULL
  AND "snapshotPackagingType" IS NOT NULL
  AND "snapshotCondition" IS NOT NULL;
