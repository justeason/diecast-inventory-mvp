-- CreateTable
CREATE TABLE "AutoListingPolicyConfig" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "minimumPricingConfidence" TEXT NOT NULL,
    "pricePositionBps" INTEGER NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoListingPolicyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoListingRun" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "startCursor" TEXT,
    "nextCursor" TEXT,
    "sourceExhausted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AutoListingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoListingAttempt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "readinessSnapshot" JSONB NOT NULL,
    "pricingSnapshot" JSONB,
    "proposedPriceCents" INTEGER,
    "riskSnapshot" JSONB,
    "listingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoListingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutoListingPolicyConfig_version_key" ON "AutoListingPolicyConfig"("version");

-- CreateIndex
CREATE INDEX "AutoListingPolicyConfig_effectiveFrom_idx" ON "AutoListingPolicyConfig"("effectiveFrom");

-- CreateIndex
CREATE INDEX "AutoListingRun_startedAt_idx" ON "AutoListingRun"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutoListingAttempt_runId_itemId_key" ON "AutoListingAttempt"("runId", "itemId");

-- CreateIndex
CREATE INDEX "AutoListingAttempt_itemId_idx" ON "AutoListingAttempt"("itemId");

-- CreateIndex
CREATE INDEX "AutoListingAttempt_outcome_idx" ON "AutoListingAttempt"("outcome");

-- AddForeignKey
ALTER TABLE "AutoListingRun" ADD CONSTRAINT "AutoListingRun_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AutoListingPolicyConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoListingAttempt" ADD CONSTRAINT "AutoListingAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutoListingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 15K: seed the initial policy version DISABLED (Part C section 5 — safe default).
-- No migration/deployment may suddenly start creating listings; an admin must
-- explicitly publish an enabled version via /admin/auto-listing.
INSERT INTO "AutoListingPolicyConfig" (
    "id", "version", "effectiveFrom", "enabled",
    "minimumPricingConfidence", "pricePositionBps",
    "notes", "createdBy"
) VALUES (
    'autolistingpolicy-seed-v1', 1, CURRENT_TIMESTAMP, false,
    'high', 5000,
    'Initial seed version — disabled by default. Publish a new version to enable.', 'system'
);
