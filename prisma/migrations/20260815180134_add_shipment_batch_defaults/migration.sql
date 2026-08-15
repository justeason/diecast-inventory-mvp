-- AlterTable
ALTER TABLE "SellerInboundShipment" ADD COLUMN     "defaultCardedOrLoose" TEXT,
ADD COLUMN     "defaultCondition" TEXT,
ADD COLUMN     "defaultStorageLocationId" TEXT;

-- CreateIndex
CREATE INDEX "SellerInboundShipment_defaultStorageLocationId_idx" ON "SellerInboundShipment"("defaultStorageLocationId");

-- AddForeignKey
ALTER TABLE "SellerInboundShipment" ADD CONSTRAINT "SellerInboundShipment_defaultStorageLocationId_fkey" FOREIGN KEY ("defaultStorageLocationId") REFERENCES "StorageLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
