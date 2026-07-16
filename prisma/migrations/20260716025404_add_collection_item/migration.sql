-- CreateTable
CREATE TABLE "CollectionItem" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "catalogId" TEXT,
    "brand" TEXT,
    "name" TEXT,
    "series" TEXT,
    "year" INTEGER,
    "color" TEXT,
    "scale" TEXT,
    "cardedOrLoose" TEXT,
    "condition" TEXT,
    "conditionNotes" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "purchasePrice" DOUBLE PRECISION,
    "purchaseDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionItem_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "CatalogModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
