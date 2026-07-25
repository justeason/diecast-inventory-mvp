-- CreateTable
CREATE TABLE "SellerAgreement" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "sellerProfileId" TEXT,
    "type" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "agreedBuyoutAmount" DECIMAL(10,2),
    "commissionPercent" DECIMAL(6,4),
    "fixedFee" DECIMAL(10,2),
    "minimumSellerPayout" DECIMAL(10,2),
    "agreedListPrice" DECIMAL(10,2),
    "sellerTermsSummary" TEXT,
    "adminNotes" TEXT,
    "proposedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptanceMethod" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellerAgreement_submissionId_idx" ON "SellerAgreement"("submissionId");

-- CreateIndex
CREATE INDEX "SellerAgreement_sellerProfileId_idx" ON "SellerAgreement"("sellerProfileId");

-- CreateIndex
CREATE INDEX "SellerAgreement_status_idx" ON "SellerAgreement"("status");

-- AddForeignKey
ALTER TABLE "SellerAgreement" ADD CONSTRAINT "SellerAgreement_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SellerSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerAgreement" ADD CONSTRAINT "SellerAgreement_sellerProfileId_fkey" FOREIGN KEY ("sellerProfileId") REFERENCES "SellerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
