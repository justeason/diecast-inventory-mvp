-- AlterTable
ALTER TABLE "SellerAgreement" ADD COLUMN     "commissionAcceptedItemCount" INTEGER,
ADD COLUMN     "commissionExplanation" TEXT,
ADD COLUMN     "commissionMinimumFee" DECIMAL(10,2),
ADD COLUMN     "commissionOverrideReason" TEXT,
ADD COLUMN     "commissionPolicyId" TEXT,
ADD COLUMN     "commissionResolvedAt" TIMESTAMP(3),
ADD COLUMN     "commissionSource" TEXT,
ADD COLUMN     "commissionTierId" TEXT;

-- AlterTable
ALTER TABLE "SellerPayoutLine" ADD COLUMN     "commissionMinimumFee" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "CommissionPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "defaultCommissionBps" INTEGER NOT NULL,
    "minimumFeeCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionTier" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "minItems" INTEGER NOT NULL,
    "commissionBps" INTEGER NOT NULL,
    "minimumFeeCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerCommissionOverride" (
    "id" TEXT NOT NULL,
    "sellerProfileId" TEXT NOT NULL,
    "commissionBps" INTEGER,
    "minimumFeeCents" INTEGER,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerCommissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionPolicy_status_idx" ON "CommissionPolicy"("status");

-- CreateIndex
CREATE INDEX "CommissionPolicy_effectiveFrom_idx" ON "CommissionPolicy"("effectiveFrom");

-- CreateIndex
CREATE INDEX "CommissionTier_policyId_idx" ON "CommissionTier"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionTier_policyId_minItems_key" ON "CommissionTier"("policyId", "minItems");

-- CreateIndex
CREATE INDEX "SellerCommissionOverride_sellerProfileId_idx" ON "SellerCommissionOverride"("sellerProfileId");

-- CreateIndex
CREATE INDEX "SellerCommissionOverride_effectiveFrom_idx" ON "SellerCommissionOverride"("effectiveFrom");

-- AddForeignKey
ALTER TABLE "CommissionTier" ADD CONSTRAINT "CommissionTier_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "CommissionPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerCommissionOverride" ADD CONSTRAINT "SellerCommissionOverride_sellerProfileId_fkey" FOREIGN KEY ("sellerProfileId") REFERENCES "SellerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerAgreement" ADD CONSTRAINT "SellerAgreement_commissionPolicyId_fkey" FOREIGN KEY ("commissionPolicyId") REFERENCES "CommissionPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerAgreement" ADD CONSTRAINT "SellerAgreement_commissionTierId_fkey" FOREIGN KEY ("commissionTierId") REFERENCES "CommissionTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
