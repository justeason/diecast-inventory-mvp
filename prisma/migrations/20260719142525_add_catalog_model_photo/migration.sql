-- CreateTable
CREATE TABLE "CatalogModelPhoto" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "altText" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogModelPhoto_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CatalogModelPhoto" ADD CONSTRAINT "CatalogModelPhoto_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "CatalogModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
