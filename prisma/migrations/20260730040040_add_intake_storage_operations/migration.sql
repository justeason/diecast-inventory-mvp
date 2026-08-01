-- AlterTable
ALTER TABLE "IntakeDraft" ADD COLUMN     "expectedQuantity" INTEGER,
ADD COLUMN     "receivedAt" TIMESTAMP(3),
ADD COLUMN     "receivedBy" TEXT,
ADD COLUMN     "receivedQuantity" INTEGER,
ADD COLUMN     "receivingNotes" TEXT,
ADD COLUMN     "storageLocationId" TEXT;

-- CreateIndex
CREATE INDEX "IntakeDraft_storageLocationId_idx" ON "IntakeDraft"("storageLocationId");

-- AddForeignKey
ALTER TABLE "IntakeDraft" ADD CONSTRAINT "IntakeDraft_storageLocationId_fkey" FOREIGN KEY ("storageLocationId") REFERENCES "StorageLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
