-- CreateTable
CREATE TABLE "CatalogSuggestion" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "collectionItemId" TEXT,
    "brand" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "series" TEXT,
    "year" INTEGER,
    "color" TEXT,
    "scale" TEXT,
    "userNotes" TEXT,
    "adminNotes" TEXT,
    "aiExtractionConfidence" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedAt" TIMESTAMP(3),
    "approvedCatalogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogSuggestion_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CatalogSuggestion" ADD CONSTRAINT "CatalogSuggestion_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogSuggestion" ADD CONSTRAINT "CatalogSuggestion_collectionItemId_fkey" FOREIGN KEY ("collectionItemId") REFERENCES "CollectionItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogSuggestion" ADD CONSTRAINT "CatalogSuggestion_approvedCatalogId_fkey" FOREIGN KEY ("approvedCatalogId") REFERENCES "CatalogModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
