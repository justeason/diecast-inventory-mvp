-- AlterTable
ALTER TABLE "BuyerAlertEvent" ADD COLUMN     "claimToken" TEXT,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "providerMessageId" TEXT;

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "BuyerAlertFanout" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "catalogModelId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "previousPriceCents" INTEGER,
    "currentPriceCents" INTEGER,
    "listingVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "cursor" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "requestId" TEXT,

    CONSTRAINT "BuyerAlertFanout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuyerAlertFanout_eventKey_key" ON "BuyerAlertFanout"("eventKey");

-- CreateIndex
CREATE INDEX "BuyerAlertFanout_status_createdAt_idx" ON "BuyerAlertFanout"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "BuyerAlertFanout" ADD CONSTRAINT "BuyerAlertFanout_catalogModelId_fkey" FOREIGN KEY ("catalogModelId") REFERENCES "CatalogModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
