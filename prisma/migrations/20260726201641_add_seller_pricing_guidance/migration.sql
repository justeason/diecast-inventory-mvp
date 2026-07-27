-- CreateTable
CREATE TABLE "SellerPricingPreference" (
    "id" TEXT NOT NULL,
    "sellerSubmissionId" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "selectedTargetPrice" DECIMAL(10,2) NOT NULL,
    "customDesiredPrice" DECIMAL(10,2),
    "suggestedFastPrice" DECIMAL(10,2),
    "suggestedMaxPrice" DECIMAL(10,2),
    "estimatedDaysToSell" INTEGER,
    "estimatedSellerProceeds" DECIMAL(10,2),
    "confidence" TEXT NOT NULL,
    "matchLevel" TEXT NOT NULL,
    "comparableCount" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerPricingPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerPricingPreference_sellerSubmissionId_key" ON "SellerPricingPreference"("sellerSubmissionId");

-- AddForeignKey
ALTER TABLE "SellerPricingPreference" ADD CONSTRAINT "SellerPricingPreference_sellerSubmissionId_fkey" FOREIGN KEY ("sellerSubmissionId") REFERENCES "SellerSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
