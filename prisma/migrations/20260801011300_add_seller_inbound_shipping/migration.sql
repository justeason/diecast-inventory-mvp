-- CreateTable
CREATE TABLE "SellerInboundShipment" (
    "id" TEXT NOT NULL,
    "sellerSubmissionId" TEXT NOT NULL,
    "intakeDraftId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "expectedQuantity" INTEGER NOT NULL,
    "receivedQuantity" INTEGER,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "sellerNotes" TEXT,
    "adminNotes" TEXT,
    "conditionStatus" TEXT,
    "issueSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerInboundShipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellerInboundShipment_sellerSubmissionId_idx" ON "SellerInboundShipment"("sellerSubmissionId");

-- CreateIndex
CREATE INDEX "SellerInboundShipment_trackingNumber_idx" ON "SellerInboundShipment"("trackingNumber");

-- CreateIndex
CREATE INDEX "SellerInboundShipment_status_idx" ON "SellerInboundShipment"("status");

-- CreateIndex
CREATE INDEX "SellerInboundShipment_receivedAt_idx" ON "SellerInboundShipment"("receivedAt");

-- AddForeignKey
ALTER TABLE "SellerInboundShipment" ADD CONSTRAINT "SellerInboundShipment_sellerSubmissionId_fkey" FOREIGN KEY ("sellerSubmissionId") REFERENCES "SellerSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerInboundShipment" ADD CONSTRAINT "SellerInboundShipment_intakeDraftId_fkey" FOREIGN KEY ("intakeDraftId") REFERENCES "IntakeDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
