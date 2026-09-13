-- 21B: introduce MarketVariant as a packaging-only (Carded/Loose) market-comparison
-- bucket between CatalogModel and physical inventory. V1 scope is packaging ONLY —
-- no chase/special-edition taxonomy, no generic attributes/label/Json metadata.
-- "Unknown" packaging is represented by marketVariantId = null wherever a source
-- record legitimately lacks the knowledge — never a fabricated "Unspecified" row.

-- ── Step 1: create MarketVariant table ──────────────────────────────────────────
CREATE TABLE "MarketVariant" (
    "id"             TEXT NOT NULL,
    "catalogModelId" TEXT NOT NULL,
    "packagingType"  TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketVariant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketVariant_catalogModelId_packagingType_key" ON "MarketVariant"("catalogModelId", "packagingType");
CREATE INDEX "MarketVariant_catalogModelId_idx" ON "MarketVariant"("catalogModelId");

ALTER TABLE "MarketVariant" ADD CONSTRAINT "MarketVariant_catalogModelId_fkey" FOREIGN KEY ("catalogModelId") REFERENCES "CatalogModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Step 2: every existing CatalogModel gets exactly Carded + Loose ─────────────
INSERT INTO "MarketVariant" ("id", "catalogModelId", "packagingType", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, cm."id", packaging."pt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "CatalogModel" cm
CROSS JOIN (VALUES ('carded'), ('loose')) AS packaging("pt");

-- ── Step 3: ItemInstance.marketVariantId — added nullable first, backfilled, then
-- made required. Precondition: every ItemInstance.cardedOrLoose must already be
-- exactly 'carded' or 'loose' — this migration never guesses a bucket for an
-- unrecognized value; it aborts with an actionable message instead.
DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count
  FROM "ItemInstance"
  WHERE "cardedOrLoose" NOT IN ('carded', 'loose');

  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration blocked: % ItemInstance row(s) have a cardedOrLoose value other than carded/loose. This migration will not guess a MarketVariant for them. Find them with: SELECT id, sku, "cardedOrLoose" FROM "ItemInstance" WHERE "cardedOrLoose" NOT IN (''carded'', ''loose''); — manually correct cardedOrLoose before retrying.', bad_count;
  END IF;
END $$;

ALTER TABLE "ItemInstance" ADD COLUMN "marketVariantId" TEXT;

UPDATE "ItemInstance" ii
SET "marketVariantId" = mv."id"
FROM "MarketVariant" mv
WHERE mv."catalogModelId" = ii."catalogId" AND mv."packagingType" = ii."cardedOrLoose";

DO $$
DECLARE
  unresolved_count integer;
BEGIN
  SELECT count(*) INTO unresolved_count FROM "ItemInstance" WHERE "marketVariantId" IS NULL;
  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'Migration blocked: % ItemInstance row(s) could not be backfilled to a MarketVariant. This should be unreachable given the precondition check above — investigate before retrying.', unresolved_count;
  END IF;
END $$;

ALTER TABLE "ItemInstance" ALTER COLUMN "marketVariantId" SET NOT NULL;
CREATE INDEX "ItemInstance_marketVariantId_idx" ON "ItemInstance"("marketVariantId");
ALTER TABLE "ItemInstance" ADD CONSTRAINT "ItemInstance_marketVariantId_fkey" FOREIGN KEY ("marketVariantId") REFERENCES "MarketVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Step 4: IntakeDraft.marketVariantId — nullable, backfilled only where both
-- catalogModelId and cardedOrLoose are already known and valid. No guessing.
ALTER TABLE "IntakeDraft" ADD COLUMN "marketVariantId" TEXT;

UPDATE "IntakeDraft" idr
SET "marketVariantId" = mv."id"
FROM "MarketVariant" mv
WHERE mv."catalogModelId" = idr."catalogModelId" AND mv."packagingType" = idr."cardedOrLoose"
  AND idr."catalogModelId" IS NOT NULL AND idr."cardedOrLoose" IN ('carded', 'loose');

CREATE INDEX "IntakeDraft_marketVariantId_idx" ON "IntakeDraft"("marketVariantId");
ALTER TABLE "IntakeDraft" ADD CONSTRAINT "IntakeDraft_marketVariantId_fkey" FOREIGN KEY ("marketVariantId") REFERENCES "MarketVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Step 5: ExternalMarketObservation.marketVariantId — nullable, admin-assigned
-- only. No backfill: packaging classification for existing observations was never
-- captured and must never be auto-derived from title text or guessed.
ALTER TABLE "ExternalMarketObservation" ADD COLUMN "marketVariantId" TEXT;

CREATE INDEX "ExternalMarketObservation_marketVariantId_idx" ON "ExternalMarketObservation"("marketVariantId");
ALTER TABLE "ExternalMarketObservation" ADD CONSTRAINT "ExternalMarketObservation_marketVariantId_fkey" FOREIGN KEY ("marketVariantId") REFERENCES "MarketVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Step 6: OrderItem identity pointers + immutable sale-fact snapshot fields.
-- catalogModelId/marketVariantId are mutable identity pointers a future admin merge
-- MAY re-point. snapshotPackagingType/snapshotCondition are immutable sale-time
-- physical facts a merge MUST NOT rewrite. All four are nullable: legacy OrderItems
-- predate trusted snapshots.
ALTER TABLE "OrderItem" ADD COLUMN "catalogModelId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "marketVariantId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "snapshotPackagingType" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "snapshotCondition" TEXT;

-- Conservative legacy backfill: catalogModelId MAY be backfilled from the item's
-- CURRENT catalogId (a durable identity pointer, safe to backfill). marketVariantId
-- and the two snapshot fields are deliberately left NULL forever for legacy rows —
-- the ItemInstance's packaging/condition may have been corrected after the historical
-- sale, so fabricating retroactive precision here would be inventing history.
UPDATE "OrderItem" oi
SET "catalogModelId" = ii."catalogId"
FROM "ItemInstance" ii
WHERE ii."id" = oi."itemId";

CREATE INDEX "OrderItem_catalogModelId_idx" ON "OrderItem"("catalogModelId");
CREATE INDEX "OrderItem_marketVariantId_idx" ON "OrderItem"("marketVariantId");
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_catalogModelId_fkey" FOREIGN KEY ("catalogModelId") REFERENCES "CatalogModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_marketVariantId_fkey" FOREIGN KEY ("marketVariantId") REFERENCES "MarketVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
