-- AlterTable
ALTER TABLE "ItemInstance" ADD COLUMN     "sellerAgreementId" TEXT,
ADD COLUMN     "sourceType" TEXT;

-- CreateIndex
CREATE INDEX "ItemInstance_sellerAgreementId_idx" ON "ItemInstance"("sellerAgreementId");

-- CreateIndex
CREATE INDEX "ItemInstance_sourceType_idx" ON "ItemInstance"("sourceType");

-- AddForeignKey
ALTER TABLE "ItemInstance" ADD CONSTRAINT "ItemInstance_sellerAgreementId_fkey" FOREIGN KEY ("sellerAgreementId") REFERENCES "SellerAgreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
