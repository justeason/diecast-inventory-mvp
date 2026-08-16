-- 15K (execution-snapshot pass): supports the DISTINCT ON (itemId) ... ORDER BY
-- itemId, createdAt DESC query behind the "Needs Manual Review" predicate.
-- CreateIndex
CREATE INDEX "AutoListingAttempt_itemId_createdAt_idx" ON "AutoListingAttempt"("itemId", "createdAt");
