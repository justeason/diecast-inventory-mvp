-- CreateTable
CREATE TABLE "SellerSubmissionPhoto" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerSubmissionPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellerSubmissionPhoto_submissionId_idx" ON "SellerSubmissionPhoto"("submissionId");

-- AddForeignKey
ALTER TABLE "SellerSubmissionPhoto" ADD CONSTRAINT "SellerSubmissionPhoto_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SellerSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
