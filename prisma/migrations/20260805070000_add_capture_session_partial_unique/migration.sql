-- Partial unique index: at most one draft session per customer per destination.
-- Submitted/cancelled sessions are not constrained by this index.
-- Backs the P2002-recovery in getOrCreateDraftSession to prevent concurrent
-- double-creates from racing past the findFirst→create gap.
CREATE UNIQUE INDEX "MobileCaptureSession_one_draft_per_dest_key"
ON "MobileCaptureSession"("customerProfileId", "destination")
WHERE status = 'draft';
