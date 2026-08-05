-- DropIndex: remove single-column unique on catalogPhotoId
DROP INDEX IF EXISTS "CatalogPhotoFingerprint_catalogPhotoId_key";

-- CreateIndex: compound unique to support multiple algorithm versions per photo
CREATE UNIQUE INDEX "CatalogPhotoFingerprint_catalogPhotoId_algorithmVersion_key" ON "CatalogPhotoFingerprint"("catalogPhotoId", "algorithmVersion");
