-- CreateTable
CREATE TABLE "IntakeDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "frontPhotoUrl" TEXT,
    "backPhotoUrl" TEXT,
    "brand" TEXT,
    "name" TEXT,
    "year" INTEGER,
    "series" TEXT,
    "color" TEXT,
    "scale" TEXT,
    "cardedOrLoose" TEXT,
    "condition" TEXT,
    "conditionNotes" TEXT,
    "listPrice" REAL,
    "storageLocation" TEXT,
    "notes" TEXT,
    "convertedItemId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IntakeDraft_convertedItemId_fkey" FOREIGN KEY ("convertedItemId") REFERENCES "ItemInstance" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "IntakeDraft_convertedItemId_key" ON "IntakeDraft"("convertedItemId");
