-- Add acquisitionDate: optional collection-only field; NULL for seller items.
ALTER TABLE "MobileCaptureItem" ADD COLUMN "acquisitionDate" TIMESTAMP(3);

-- Add payloadFingerprint: server-computed SHA-256 of the normalized item payload.
-- Not exposed to the client; used for full-payload idempotency on clientToken retry.
-- Default '' for the migration; application always writes a real value on create.
ALTER TABLE "MobileCaptureItem" ADD COLUMN "payloadFingerprint" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MobileCaptureItem" ALTER COLUMN "payloadFingerprint" DROP DEFAULT;

-- Unique constraint: one queue row per catalog model per session.
-- Prevents the same model from appearing twice under different client tokens.
ALTER TABLE "MobileCaptureItem"
    ADD CONSTRAINT "MobileCaptureItem_sessionId_catalogModelId_key"
    UNIQUE ("sessionId", "catalogModelId");
