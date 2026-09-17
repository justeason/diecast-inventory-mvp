-- CreateTable
CREATE TABLE "AcquisitionLot" (
    "id" TEXT NOT NULL,
    "collectionItemId" TEXT NOT NULL,
    "quantityAcquired" INTEGER NOT NULL,
    "remainingQuantity" INTEGER NOT NULL,
    "unitRecordedCostCents" INTEGER,
    "legacyRecordedPriceCents" INTEGER,
    "costKnowledge" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3),
    "ledgerEffectiveAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "sourceKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcquisitionLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionDisposal" (
    "id" TEXT NOT NULL,
    "collectionItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "disposalType" TEXT NOT NULL,
    "disposedAt" TIMESTAMP(3) NOT NULL,
    "grossProceedsCents" INTEGER,
    "netProceedsCents" INTEGER,
    "sourceKey" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionDisposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionDisposalAllocation" (
    "id" TEXT NOT NULL,
    "disposalId" TEXT NOT NULL,
    "acquisitionLotId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "allocatedRecordedCostCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionDisposalAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcquisitionLot_sourceKey_key" ON "AcquisitionLot"("sourceKey");

-- CreateIndex
CREATE INDEX "AcquisitionLot_collectionItemId_idx" ON "AcquisitionLot"("collectionItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionDisposal_sourceKey_key" ON "CollectionDisposal"("sourceKey");

-- CreateIndex
CREATE INDEX "CollectionDisposal_collectionItemId_idx" ON "CollectionDisposal"("collectionItemId");

-- CreateIndex
CREATE INDEX "CollectionDisposal_disposalType_idx" ON "CollectionDisposal"("disposalType");

-- CreateIndex
CREATE INDEX "CollectionDisposalAllocation_disposalId_idx" ON "CollectionDisposalAllocation"("disposalId");

-- CreateIndex
CREATE INDEX "CollectionDisposalAllocation_acquisitionLotId_idx" ON "CollectionDisposalAllocation"("acquisitionLotId");

-- AddForeignKey
ALTER TABLE "AcquisitionLot" ADD CONSTRAINT "AcquisitionLot_collectionItemId_fkey" FOREIGN KEY ("collectionItemId") REFERENCES "CollectionItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionDisposal" ADD CONSTRAINT "CollectionDisposal_collectionItemId_fkey" FOREIGN KEY ("collectionItemId") REFERENCES "CollectionItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionDisposalAllocation" ADD CONSTRAINT "CollectionDisposalAllocation_disposalId_fkey" FOREIGN KEY ("disposalId") REFERENCES "CollectionDisposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionDisposalAllocation" ADD CONSTRAINT "CollectionDisposalAllocation_acquisitionLotId_fkey" FOREIGN KEY ("acquisitionLotId") REFERENCES "AcquisitionLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

