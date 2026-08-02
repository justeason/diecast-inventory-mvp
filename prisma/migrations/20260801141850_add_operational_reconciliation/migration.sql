-- CreateTable
CREATE TABLE "OperationalReconciliationAudit" (
    "id" TEXT NOT NULL,
    "issueKey" TEXT NOT NULL,
    "repairType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeSnapshot" JSONB NOT NULL,
    "afterSnapshot" JSONB NOT NULL,
    "result" TEXT NOT NULL,
    "adminInfo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalReconciliationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationalReconciliationAudit_issueKey_idx" ON "OperationalReconciliationAudit"("issueKey");

-- CreateIndex
CREATE INDEX "OperationalReconciliationAudit_entityType_entityId_idx" ON "OperationalReconciliationAudit"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "OperationalReconciliationAudit_createdAt_idx" ON "OperationalReconciliationAudit"("createdAt");
