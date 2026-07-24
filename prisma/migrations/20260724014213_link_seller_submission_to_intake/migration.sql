-- AlterTable
ALTER TABLE "IntakeDraft" ADD COLUMN     "sellerSubmissionId" TEXT;

-- CreateIndex
CREATE INDEX "IntakeDraft_sellerSubmissionId_idx" ON "IntakeDraft"("sellerSubmissionId");

-- AddForeignKey
ALTER TABLE "IntakeDraft" ADD CONSTRAINT "IntakeDraft_sellerSubmissionId_fkey" FOREIGN KEY ("sellerSubmissionId") REFERENCES "SellerSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
