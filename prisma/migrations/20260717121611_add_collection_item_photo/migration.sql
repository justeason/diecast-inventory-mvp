-- CreateTable
CREATE TABLE "CollectionItemPhoto" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'other',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionItemPhoto_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CollectionItemPhoto" ADD CONSTRAINT "CollectionItemPhoto_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CollectionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
