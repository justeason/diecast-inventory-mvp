-- CreateTable
CREATE TABLE "CatalogModelMergeAudit" (
    "id" TEXT NOT NULL,
    "canonicalCatalogModelId" TEXT NOT NULL,
    "duplicateCatalogModelId" TEXT NOT NULL,
    "canonicalSnapshot" JSONB NOT NULL,
    "duplicateSnapshot" JSONB NOT NULL,
    "movedItemInstances" INTEGER NOT NULL DEFAULT 0,
    "movedCollectionItems" INTEGER NOT NULL DEFAULT 0,
    "movedSellerSubmissions" INTEGER NOT NULL DEFAULT 0,
    "movedCatalogSuggestions" INTEGER NOT NULL DEFAULT 0,
    "movedPhotos" INTEGER NOT NULL DEFAULT 0,
    "adminNote" TEXT,
    "mergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogModelMergeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogDuplicateSuppression" (
    "id" TEXT NOT NULL,
    "pairKey" TEXT NOT NULL,
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogDuplicateSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogModelMergeAudit_canonicalCatalogModelId_idx" ON "CatalogModelMergeAudit"("canonicalCatalogModelId");

-- CreateIndex
CREATE INDEX "CatalogModelMergeAudit_duplicateCatalogModelId_idx" ON "CatalogModelMergeAudit"("duplicateCatalogModelId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogDuplicateSuppression_pairKey_key" ON "CatalogDuplicateSuppression"("pairKey");
