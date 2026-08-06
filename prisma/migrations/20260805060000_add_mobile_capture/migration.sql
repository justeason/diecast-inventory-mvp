-- CreateTable: MobileCaptureSession
CREATE TABLE "MobileCaptureSession" (
    "id" TEXT NOT NULL,
    "customerProfileId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MobileCaptureSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable: MobileCaptureItem
CREATE TABLE "MobileCaptureItem" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "catalogModelId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "condition" TEXT,
    "notes" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "saleTypePreference" TEXT,
    "clientToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MobileCaptureItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MobileCaptureSession_customerProfileId_status_idx" ON "MobileCaptureSession"("customerProfileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MobileCaptureItem_sessionId_clientToken_key" ON "MobileCaptureItem"("sessionId", "clientToken");

-- CreateIndex
CREATE INDEX "MobileCaptureItem_sessionId_idx" ON "MobileCaptureItem"("sessionId");

-- AddForeignKey
ALTER TABLE "MobileCaptureSession" ADD CONSTRAINT "MobileCaptureSession_customerProfileId_fkey"
    FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileCaptureItem" ADD CONSTRAINT "MobileCaptureItem_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "MobileCaptureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileCaptureItem" ADD CONSTRAINT "MobileCaptureItem_catalogModelId_fkey"
    FOREIGN KEY ("catalogModelId") REFERENCES "CatalogModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
