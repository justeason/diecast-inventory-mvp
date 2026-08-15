-- CreateTable
CREATE TABLE "RiskPolicyConfig" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "highValueReviewThresholdCents" INTEGER NOT NULL,
    "veryHighValueThresholdCents" INTEGER NOT NULL,
    "payoutApprovalThresholdCents" INTEGER NOT NULL,
    "priceDeviationToleranceBps" INTEGER NOT NULL,
    "destructiveActionsRequireApproval" BOOLEAN NOT NULL DEFAULT true,
    "commercialOverridesRequireApproval" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskPolicyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskApprovalRequest" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "riskLevel" TEXT NOT NULL,
    "policyCode" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "contextFingerprint" TEXT NOT NULL,
    "decisionContext" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RiskPolicyConfig_version_key" ON "RiskPolicyConfig"("version");

-- CreateIndex
CREATE INDEX "RiskPolicyConfig_effectiveFrom_idx" ON "RiskPolicyConfig"("effectiveFrom");

-- CreateIndex
CREATE INDEX "RiskApprovalRequest_status_riskLevel_idx" ON "RiskApprovalRequest"("status", "riskLevel");

-- CreateIndex
CREATE INDEX "RiskApprovalRequest_action_targetId_contextFingerprint_idx" ON "RiskApprovalRequest"("action", "targetId", "contextFingerprint");

-- CreateIndex
CREATE INDEX "RiskApprovalRequest_targetType_targetId_idx" ON "RiskApprovalRequest"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "RiskApprovalRequest_createdAt_idx" ON "RiskApprovalRequest"("createdAt");

-- 15F: seed the initial policy version so the engine always has an effective config
-- to evaluate against (version 1, effective immediately). Values are a documented
-- starting point only, not a hardcoded permanent business rule -- adjustable at any
-- time via /admin/risk-policies (each change creates a new versioned row, never
-- mutates this one).
INSERT INTO "RiskPolicyConfig" (
    "id", "version", "effectiveFrom",
    "highValueReviewThresholdCents", "veryHighValueThresholdCents",
    "payoutApprovalThresholdCents", "priceDeviationToleranceBps",
    "destructiveActionsRequireApproval", "commercialOverridesRequireApproval",
    "notes", "createdBy"
) VALUES (
    'riskpolicy-seed-v1', 1, CURRENT_TIMESTAMP,
    20000, 100000,
    100000, 1500,
    true, true,
    'Initial seeded policy (15F rollout) -- review and adjust via /admin/risk-policies.',
    'system_migration'
);
