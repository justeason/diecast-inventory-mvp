-- AlterTable
ALTER TABLE "WantedCatalogModel" ADD COLUMN     "availabilityAlertEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "priceAlertEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "BuyerAlertPreference" (
    "id" TEXT NOT NULL,
    "customerProfileId" TEXT NOT NULL,
    "wantedAvailableAlerts" BOOLEAN NOT NULL DEFAULT true,
    "wantedPriceChangeAlerts" BOOLEAN NOT NULL DEFAULT true,
    "emailAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "priceChangeThresholdPct" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerAlertPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerAlertEvent" (
    "id" TEXT NOT NULL,
    "customerProfileId" TEXT NOT NULL,
    "catalogModelId" TEXT NOT NULL,
    "listingId" TEXT,
    "alertType" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "previousPriceCents" INTEGER,
    "currentPriceCents" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failureCode" TEXT,

    CONSTRAINT "BuyerAlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuyerAlertPreference_customerProfileId_key" ON "BuyerAlertPreference"("customerProfileId");

-- CreateIndex
CREATE INDEX "BuyerAlertEvent_customerProfileId_createdAt_idx" ON "BuyerAlertEvent"("customerProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "BuyerAlertEvent_status_createdAt_idx" ON "BuyerAlertEvent"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerAlertEvent_customerProfileId_eventKey_key" ON "BuyerAlertEvent"("customerProfileId", "eventKey");

-- AddForeignKey
ALTER TABLE "BuyerAlertPreference" ADD CONSTRAINT "BuyerAlertPreference_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerAlertEvent" ADD CONSTRAINT "BuyerAlertEvent_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerAlertEvent" ADD CONSTRAINT "BuyerAlertEvent_catalogModelId_fkey" FOREIGN KEY ("catalogModelId") REFERENCES "CatalogModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
