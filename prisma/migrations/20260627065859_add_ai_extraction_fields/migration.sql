-- AlterTable
ALTER TABLE "IntakeDraft" ADD COLUMN "aiExtractionConfidence" REAL;
ALTER TABLE "IntakeDraft" ADD COLUMN "aiExtractionNotes" TEXT;
ALTER TABLE "IntakeDraft" ADD COLUMN "aiExtractionRaw" TEXT;
