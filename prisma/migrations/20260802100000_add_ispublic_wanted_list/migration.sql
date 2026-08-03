-- Add isPublic to CollectionItem
ALTER TABLE "CollectionItem" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false;

-- Create WantedCatalogModel
CREATE TABLE "WantedCatalogModel" (
    "id" TEXT NOT NULL,
    "customerProfileId" TEXT NOT NULL,
    "catalogModelId" TEXT NOT NULL,
    "maxDesiredPrice" DECIMAL(10,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WantedCatalogModel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WantedCatalogModel_customerProfileId_catalogModelId_key" ON "WantedCatalogModel"("customerProfileId", "catalogModelId");
CREATE INDEX "WantedCatalogModel_customerProfileId_idx" ON "WantedCatalogModel"("customerProfileId");

ALTER TABLE "WantedCatalogModel" ADD CONSTRAINT "WantedCatalogModel_customerProfileId_fkey"
    FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WantedCatalogModel" ADD CONSTRAINT "WantedCatalogModel_catalogModelId_fkey"
    FOREIGN KEY ("catalogModelId") REFERENCES "CatalogModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
