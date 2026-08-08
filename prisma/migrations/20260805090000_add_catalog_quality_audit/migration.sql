-- CatalogDataQualityAudit: stores repair history for catalog data quality actions.
-- Plain string fields (not FK) so the audit survives model/photo changes.
CREATE TABLE "CatalogDataQualityAudit" (
    "id"             TEXT NOT NULL,
    "issueKey"       TEXT NOT NULL,
    "action"         TEXT NOT NULL,
    "catalogModelId" TEXT NOT NULL,
    "beforeSnapshot" JSONB NOT NULL,
    "afterSnapshot"  JSONB NOT NULL,
    "adminNote"      TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogDataQualityAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogDataQualityAudit_catalogModelId_idx" ON "CatalogDataQualityAudit"("catalogModelId");
CREATE INDEX "CatalogDataQualityAudit_issueKey_idx"       ON "CatalogDataQualityAudit"("issueKey");
CREATE INDEX "CatalogDataQualityAudit_createdAt_idx"      ON "CatalogDataQualityAudit"("createdAt");
