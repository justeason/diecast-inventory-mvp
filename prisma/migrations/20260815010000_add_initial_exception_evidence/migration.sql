-- AlterTable
ALTER TABLE "IntakeDraft" ADD COLUMN     "initialExceptionAt" TIMESTAMP(3),
ADD COLUMN     "initialExceptionCode" TEXT,
ADD COLUMN     "initialExceptionNote" TEXT;


-- 15E-review (evidence pass): deterministic backfill for pre-existing exception
-- drafts. The current stored workbenchExceptionCode/Note is the only evidence that
-- ever existed for these rows, so it is copied verbatim into the immutable initial
-- fields (never fabricating an earlier history that was never persisted).
-- createdAt is used as the best available deterministic proxy for "first became an
-- exception" -- for the overwhelming majority of rows (created directly with an
-- exception code by the workbench) this is exact; only the rare conversion_failed-
-- after-attempted-conversion case is an approximation, which is the best available
-- fact, not a guess. Scoped to WHERE workbenchExceptionCode IS NOT NULL, so rows that
-- never had exception evidence (normal converted items, rejected legacy drafts) are
-- never touched.
UPDATE "IntakeDraft"
SET "initialExceptionCode" = "workbenchExceptionCode",
    "initialExceptionNote" = "workbenchExceptionNote",
    "initialExceptionAt" = "createdAt"
WHERE "workbenchExceptionCode" IS NOT NULL
  AND "initialExceptionCode" IS NULL;
