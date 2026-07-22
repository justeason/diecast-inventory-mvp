-- CreateTable
CREATE TABLE "SellerSubmission" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "collectionItemId" TEXT,
    "catalogId" TEXT,
    "brand" TEXT,
    "name" TEXT,
    "series" TEXT,
    "year" INTEGER,
    "color" TEXT,
    "scale" TEXT,
    "cardedOrLoose" TEXT,
    "condition" TEXT,
    "conditionNotes" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "saleTypePreference" TEXT,
    "expectedPrice" DOUBLE PRECISION,
    "userNotes" TEXT,
    "userMessage" TEXT,
    "adminNotes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellerSubmission_profileId_idx" ON "SellerSubmission"("profileId");

-- CreateIndex
CREATE INDEX "SellerSubmission_status_idx" ON "SellerSubmission"("status");

-- CreateIndex
CREATE INDEX "SellerSubmission_collectionItemId_idx" ON "SellerSubmission"("collectionItemId");

-- AddForeignKey
ALTER TABLE "SellerSubmission" ADD CONSTRAINT "SellerSubmission_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerSubmission" ADD CONSTRAINT "SellerSubmission_collectionItemId_fkey" FOREIGN KEY ("collectionItemId") REFERENCES "CollectionItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerSubmission" ADD CONSTRAINT "SellerSubmission_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "CatalogModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
