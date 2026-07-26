-- AlterTable
ALTER TABLE "IntakeDraft" ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "sellerRejectionReason" TEXT;

-- CreateTable
CREATE TABLE "SellerLifecycleEvent" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "sellerSubmissionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "sourceEntityType" TEXT,
    "sourceEntityId" TEXT,
    "sellerVisible" BOOLEAN NOT NULL DEFAULT false,
    "sellerTitle" TEXT,
    "sellerDescription" TEXT,
    "adminDescription" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerLifecycleCase" (
    "id" TEXT NOT NULL,
    "sellerSubmissionId" TEXT NOT NULL,
    "caseType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "agreementId" TEXT,
    "intakeDraftId" TEXT,
    "itemInstanceId" TEXT,
    "listingId" TEXT,
    "orderId" TEXT,
    "orderItemId" TEXT,
    "sellerPayoutLineId" TEXT,
    "sellerVisible" BOOLEAN NOT NULL DEFAULT false,
    "sellerMessage" TEXT,
    "adminNotes" TEXT,
    "resolutionSummary" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "returnCarrier" TEXT,
    "returnTrackingNumber" TEXT,
    "returnShippedAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerLifecycleCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerLifecycleEvent_eventKey_key" ON "SellerLifecycleEvent"("eventKey");

-- CreateIndex
CREATE INDEX "SellerLifecycleEvent_sellerSubmissionId_idx" ON "SellerLifecycleEvent"("sellerSubmissionId");

-- CreateIndex
CREATE INDEX "SellerLifecycleEvent_eventType_idx" ON "SellerLifecycleEvent"("eventType");

-- CreateIndex
CREATE INDEX "SellerLifecycleEvent_sourceEntityType_sourceEntityId_idx" ON "SellerLifecycleEvent"("sourceEntityType", "sourceEntityId");

-- CreateIndex
CREATE INDEX "SellerLifecycleEvent_occurredAt_idx" ON "SellerLifecycleEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "SellerLifecycleCase_sellerSubmissionId_idx" ON "SellerLifecycleCase"("sellerSubmissionId");

-- CreateIndex
CREATE INDEX "SellerLifecycleCase_caseType_idx" ON "SellerLifecycleCase"("caseType");

-- CreateIndex
CREATE INDEX "SellerLifecycleCase_status_idx" ON "SellerLifecycleCase"("status");

-- CreateIndex
CREATE INDEX "SellerLifecycleCase_orderId_idx" ON "SellerLifecycleCase"("orderId");

-- CreateIndex
CREATE INDEX "SellerLifecycleCase_orderItemId_idx" ON "SellerLifecycleCase"("orderItemId");

-- CreateIndex
CREATE INDEX "SellerLifecycleCase_itemInstanceId_idx" ON "SellerLifecycleCase"("itemInstanceId");

-- CreateIndex
CREATE INDEX "SellerLifecycleCase_sellerPayoutLineId_idx" ON "SellerLifecycleCase"("sellerPayoutLineId");

-- AddForeignKey
ALTER TABLE "SellerLifecycleEvent" ADD CONSTRAINT "SellerLifecycleEvent_sellerSubmissionId_fkey" FOREIGN KEY ("sellerSubmissionId") REFERENCES "SellerSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerLifecycleCase" ADD CONSTRAINT "SellerLifecycleCase_sellerSubmissionId_fkey" FOREIGN KEY ("sellerSubmissionId") REFERENCES "SellerSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
