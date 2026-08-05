-- CreateTable
CREATE TABLE "ExternalMarketImportBatch" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "originalFileName" TEXT,
    "importHash" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "adminInfo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalMarketImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalMarketObservation" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "observationType" TEXT NOT NULL,
    "catalogModelId" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'unmatched',
    "matchMethod" TEXT,
    "title" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "currency" TEXT NOT NULL,
    "price" DECIMAL(12,4) NOT NULL,
    "shippingPrice" DECIMAL(12,4),
    "totalPrice" DECIMAL(12,4) NOT NULL,
    "soldAt" TIMESTAMP(3),
    "listedAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3) NOT NULL,
    "condition" TEXT,
    "locationText" TEXT,
    "rawSnapshot" JSONB,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalMarketObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalMarketObservationAudit" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeSnapshot" JSONB NOT NULL,
    "afterSnapshot" JSONB NOT NULL,
    "adminInfo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalMarketObservationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalMarketImportBatch_importHash_key" ON "ExternalMarketImportBatch"("importHash");

-- CreateIndex
CREATE INDEX "ExternalMarketImportBatch_provider_idx" ON "ExternalMarketImportBatch"("provider");

-- CreateIndex
CREATE INDEX "ExternalMarketImportBatch_createdAt_idx" ON "ExternalMarketImportBatch"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalMarketObservation_fingerprint_key" ON "ExternalMarketObservation"("fingerprint");

-- CreateIndex
CREATE INDEX "ExternalMarketObservation_provider_idx" ON "ExternalMarketObservation"("provider");

-- CreateIndex
CREATE INDEX "ExternalMarketObservation_observationType_idx" ON "ExternalMarketObservation"("observationType");

-- CreateIndex
CREATE INDEX "ExternalMarketObservation_catalogModelId_idx" ON "ExternalMarketObservation"("catalogModelId");

-- CreateIndex
CREATE INDEX "ExternalMarketObservation_observedAt_idx" ON "ExternalMarketObservation"("observedAt");

-- CreateIndex
CREATE INDEX "ExternalMarketObservation_soldAt_idx" ON "ExternalMarketObservation"("soldAt");

-- CreateIndex
CREATE INDEX "ExternalMarketObservation_matchStatus_idx" ON "ExternalMarketObservation"("matchStatus");

-- CreateIndex
CREATE INDEX "ExternalMarketObservation_importBatchId_idx" ON "ExternalMarketObservation"("importBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalMarketObservation_provider_externalId_key" ON "ExternalMarketObservation"("provider", "externalId");

-- CreateIndex
CREATE INDEX "ExternalMarketObservationAudit_observationId_idx" ON "ExternalMarketObservationAudit"("observationId");

-- CreateIndex
CREATE INDEX "ExternalMarketObservationAudit_createdAt_idx" ON "ExternalMarketObservationAudit"("createdAt");

-- AddForeignKey
ALTER TABLE "ExternalMarketObservation" ADD CONSTRAINT "ExternalMarketObservation_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ExternalMarketImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalMarketObservation" ADD CONSTRAINT "ExternalMarketObservation_catalogModelId_fkey" FOREIGN KEY ("catalogModelId") REFERENCES "CatalogModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalMarketObservationAudit" ADD CONSTRAINT "ExternalMarketObservationAudit_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "ExternalMarketObservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
