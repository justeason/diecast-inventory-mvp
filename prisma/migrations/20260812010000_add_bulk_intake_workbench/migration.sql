-- AlterTable
ALTER TABLE "IntakeDraft" ADD COLUMN     "catalogModelId" TEXT,
ADD COLUMN     "sellerInboundShipmentId" TEXT,
ADD COLUMN     "workbenchClientToken" TEXT,
ADD COLUMN     "workbenchExceptionCode" TEXT,
ADD COLUMN     "workbenchExceptionNote" TEXT;

-- AlterTable
ALTER TABLE "ItemInstance" ADD COLUMN     "sellerInboundShipmentId" TEXT;

-- CreateTable
CREATE TABLE "IntakeWorkbenchSession" (
    "id" TEXT NOT NULL,
    "sellerInboundShipmentId" TEXT NOT NULL,
    "claimToken" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3),

    CONSTRAINT "IntakeWorkbenchSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntakeWorkbenchSession_sellerInboundShipmentId_key" ON "IntakeWorkbenchSession"("sellerInboundShipmentId");

-- CreateIndex
CREATE INDEX "IntakeDraft_catalogModelId_idx" ON "IntakeDraft"("catalogModelId");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeDraft_sellerInboundShipmentId_workbenchClientToken_key" ON "IntakeDraft"("sellerInboundShipmentId", "workbenchClientToken");

-- CreateIndex
CREATE INDEX "ItemInstance_sellerInboundShipmentId_idx" ON "ItemInstance"("sellerInboundShipmentId");

-- AddForeignKey
ALTER TABLE "ItemInstance" ADD CONSTRAINT "ItemInstance_sellerInboundShipmentId_fkey" FOREIGN KEY ("sellerInboundShipmentId") REFERENCES "SellerInboundShipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeDraft" ADD CONSTRAINT "IntakeDraft_catalogModelId_fkey" FOREIGN KEY ("catalogModelId") REFERENCES "CatalogModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeDraft" ADD CONSTRAINT "IntakeDraft_sellerInboundShipmentId_fkey" FOREIGN KEY ("sellerInboundShipmentId") REFERENCES "SellerInboundShipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeWorkbenchSession" ADD CONSTRAINT "IntakeWorkbenchSession_sellerInboundShipmentId_fkey" FOREIGN KEY ("sellerInboundShipmentId") REFERENCES "SellerInboundShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

