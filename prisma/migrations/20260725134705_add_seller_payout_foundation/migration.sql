-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "completedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SellerPayoutLine" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "lineType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'eligible',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "customerProfileId" TEXT NOT NULL,
    "agreementId" TEXT,
    "orderItemId" TEXT,
    "payoutId" TEXT,
    "grossSalePrice" DECIMAL(10,2),
    "agreedBuyoutAmount" DECIMAL(10,2),
    "commissionPercent" DECIMAL(6,4),
    "commissionAmount" DECIMAL(10,2),
    "fixedFee" DECIMAL(10,2),
    "minimumSellerPayout" DECIMAL(10,2),
    "minimumAdjustment" DECIMAL(10,2),
    "netAmount" DECIMAL(10,2) NOT NULL,
    "eligibleAt" TIMESTAMP(3) NOT NULL,
    "heldAt" TIMESTAMP(3),
    "holdReason" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerPayoutLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerPayout" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "customerProfileId" TEXT NOT NULL,
    "sellerProfileId" TEXT,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerPayoutLine_sourceKey_key" ON "SellerPayoutLine"("sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPayoutLine_orderItemId_key" ON "SellerPayoutLine"("orderItemId");

-- CreateIndex
CREATE INDEX "SellerPayoutLine_customerProfileId_idx" ON "SellerPayoutLine"("customerProfileId");

-- CreateIndex
CREATE INDEX "SellerPayoutLine_agreementId_idx" ON "SellerPayoutLine"("agreementId");

-- CreateIndex
CREATE INDEX "SellerPayoutLine_payoutId_idx" ON "SellerPayoutLine"("payoutId");

-- CreateIndex
CREATE INDEX "SellerPayoutLine_status_idx" ON "SellerPayoutLine"("status");

-- CreateIndex
CREATE INDEX "SellerPayoutLine_lineType_idx" ON "SellerPayoutLine"("lineType");

-- CreateIndex
CREATE INDEX "SellerPayout_customerProfileId_idx" ON "SellerPayout"("customerProfileId");

-- CreateIndex
CREATE INDEX "SellerPayout_sellerProfileId_idx" ON "SellerPayout"("sellerProfileId");

-- CreateIndex
CREATE INDEX "SellerPayout_status_idx" ON "SellerPayout"("status");

-- AddForeignKey
ALTER TABLE "SellerPayoutLine" ADD CONSTRAINT "SellerPayoutLine_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutLine" ADD CONSTRAINT "SellerPayoutLine_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "SellerAgreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutLine" ADD CONSTRAINT "SellerPayoutLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayoutLine" ADD CONSTRAINT "SellerPayoutLine_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "SellerPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPayout" ADD CONSTRAINT "SellerPayout_sellerProfileId_fkey" FOREIGN KEY ("sellerProfileId") REFERENCES "SellerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
