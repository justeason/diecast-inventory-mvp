-- AlterTable
ALTER TABLE "ItemInstance" ADD COLUMN     "sellerPortfolioId" TEXT;

-- AlterTable
ALTER TABLE "SellerAgreement" ADD COLUMN     "sellerPortfolioId" TEXT;

-- AlterTable
ALTER TABLE "SellerInboundShipment" ADD COLUMN     "sellerPortfolioId" TEXT;

-- AlterTable
ALTER TABLE "SellerSubmission" ADD COLUMN     "sellerPortfolioId" TEXT;

-- CreateTable
CREATE TABLE "SellerPortfolio" (
    "id" TEXT NOT NULL,
    "sellerProfileId" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "expectedItemCount" INTEGER,
    "acceptedItemCount" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SellerPortfolio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellerPortfolio_sellerProfileId_idx" ON "SellerPortfolio"("sellerProfileId");

-- CreateIndex
CREATE INDEX "SellerPortfolio_status_idx" ON "SellerPortfolio"("status");

-- CreateIndex
CREATE INDEX "ItemInstance_sellerPortfolioId_idx" ON "ItemInstance"("sellerPortfolioId");

-- CreateIndex
CREATE INDEX "SellerAgreement_sellerPortfolioId_idx" ON "SellerAgreement"("sellerPortfolioId");

-- CreateIndex
CREATE INDEX "SellerInboundShipment_sellerPortfolioId_idx" ON "SellerInboundShipment"("sellerPortfolioId");

-- CreateIndex
CREATE INDEX "SellerSubmission_sellerPortfolioId_idx" ON "SellerSubmission"("sellerPortfolioId");

-- AddForeignKey
ALTER TABLE "ItemInstance" ADD CONSTRAINT "ItemInstance_sellerPortfolioId_fkey" FOREIGN KEY ("sellerPortfolioId") REFERENCES "SellerPortfolio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPortfolio" ADD CONSTRAINT "SellerPortfolio_sellerProfileId_fkey" FOREIGN KEY ("sellerProfileId") REFERENCES "SellerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerSubmission" ADD CONSTRAINT "SellerSubmission_sellerPortfolioId_fkey" FOREIGN KEY ("sellerPortfolioId") REFERENCES "SellerPortfolio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerAgreement" ADD CONSTRAINT "SellerAgreement_sellerPortfolioId_fkey" FOREIGN KEY ("sellerPortfolioId") REFERENCES "SellerPortfolio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerInboundShipment" ADD CONSTRAINT "SellerInboundShipment_sellerPortfolioId_fkey" FOREIGN KEY ("sellerPortfolioId") REFERENCES "SellerPortfolio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
