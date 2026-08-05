-- CreateTable
CREATE TABLE "CatalogPhotoFingerprint" (
    "id" TEXT NOT NULL,
    "catalogModelId" TEXT NOT NULL,
    "catalogPhotoId" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "perceptualHash" TEXT NOT NULL,
    "hashBand0" TEXT NOT NULL,
    "hashBand1" TEXT NOT NULL,
    "hashBand2" TEXT NOT NULL,
    "hashBand3" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "algorithmVersion" TEXT NOT NULL DEFAULT 'dhash-v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogPhotoFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalogPhotoFingerprint_catalogPhotoId_key" ON "CatalogPhotoFingerprint"("catalogPhotoId");

-- CreateIndex
CREATE INDEX "CatalogPhotoFingerprint_catalogModelId_idx" ON "CatalogPhotoFingerprint"("catalogModelId");

-- CreateIndex
CREATE INDEX "CatalogPhotoFingerprint_contentSha256_idx" ON "CatalogPhotoFingerprint"("contentSha256");

-- CreateIndex
CREATE INDEX "CatalogPhotoFingerprint_hashBand0_idx" ON "CatalogPhotoFingerprint"("hashBand0");

-- CreateIndex
CREATE INDEX "CatalogPhotoFingerprint_hashBand1_idx" ON "CatalogPhotoFingerprint"("hashBand1");

-- CreateIndex
CREATE INDEX "CatalogPhotoFingerprint_hashBand2_idx" ON "CatalogPhotoFingerprint"("hashBand2");

-- CreateIndex
CREATE INDEX "CatalogPhotoFingerprint_hashBand3_idx" ON "CatalogPhotoFingerprint"("hashBand3");

-- AddForeignKey
ALTER TABLE "CatalogPhotoFingerprint" ADD CONSTRAINT "CatalogPhotoFingerprint_catalogModelId_fkey" FOREIGN KEY ("catalogModelId") REFERENCES "CatalogModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogPhotoFingerprint" ADD CONSTRAINT "CatalogPhotoFingerprint_catalogPhotoId_fkey" FOREIGN KEY ("catalogPhotoId") REFERENCES "CatalogModelPhoto"("id") ON DELETE CASCADE ON UPDATE CASCADE;
