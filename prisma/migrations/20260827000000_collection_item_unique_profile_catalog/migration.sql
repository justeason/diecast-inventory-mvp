-- 16F Final: DB-enforced "one catalog-linked CollectionItem per customer".
-- Closes a check-then-create race in createCollectionItem (concurrent Add to
-- Collection requests for the same model could otherwise both pass the pre-read
-- and create two rows). Postgres unique indexes treat NULL as distinct from any
-- other NULL, so existing freeform (catalogId IS NULL) rows are unaffected and
-- customers may still have any number of them.
--
-- 16F Final Persistence Integrity Pass: explicit precondition check before
-- installing the constraint. Uniqueness was previously enforced only by a racy
-- check-then-create, so historical duplicate (profileId, catalogId) pairs are
-- possible. This migration NEVER deletes or merges duplicate rows automatically —
-- different duplicate rows may carry different quantity/condition/carded-loose/
-- photos/notes, and silently choosing a "winner" (or summing quantities) would
-- invent reconciliation semantics that belong to a human decision, not a
-- migration. If duplicates exist, this migration fails clearly with an
-- actionable message instead of Postgres's opaque unique-index-creation error.
DO $$
DECLARE
  duplicate_count integer;
BEGIN
  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT "profileId", "catalogId"
    FROM "CollectionItem"
    WHERE "catalogId" IS NOT NULL
    GROUP BY "profileId", "catalogId"
    HAVING count(*) > 1
  ) AS dupes;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Migration blocked: % customer/catalog-model pair(s) have more than one CollectionItem row. This migration will not delete or merge them automatically. Find them with: SELECT "profileId", "catalogId", count(*) FROM "CollectionItem" WHERE "catalogId" IS NOT NULL GROUP BY "profileId", "catalogId" HAVING count(*) > 1; — manually reconcile (choose which row to keep, or merge quantity/condition/photos/notes by hand) before retrying this migration.', duplicate_count;
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "CollectionItem_profileId_catalogId_key" ON "CollectionItem"("profileId", "catalogId");
