-- CreateTable
CREATE TABLE "GuestSellerSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestSellerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestSellerItem" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "catalogModelId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "condition" TEXT,
    "notes" TEXT,
    "saleTypePreference" TEXT,
    "clientToken" TEXT NOT NULL,
    "payloadFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestSellerItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestSellerSession_tokenHash_key" ON "GuestSellerSession"("tokenHash");

-- CreateIndex
CREATE INDEX "GuestSellerSession_expiresAt_idx" ON "GuestSellerSession"("expiresAt");

-- CreateIndex
CREATE INDEX "GuestSellerItem_sessionId_idx" ON "GuestSellerItem"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestSellerItem_sessionId_clientToken_key" ON "GuestSellerItem"("sessionId", "clientToken");

-- CreateIndex
CREATE UNIQUE INDEX "GuestSellerItem_sessionId_catalogModelId_key" ON "GuestSellerItem"("sessionId", "catalogModelId");

-- AddForeignKey
ALTER TABLE "GuestSellerItem" ADD CONSTRAINT "GuestSellerItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GuestSellerSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestSellerItem" ADD CONSTRAINT "GuestSellerItem_catalogModelId_fkey" FOREIGN KEY ("catalogModelId") REFERENCES "CatalogModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

