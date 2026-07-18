-- AlterTable
ALTER TABLE "CollectionItem" ADD COLUMN     "aiExtractedAt" TIMESTAMP(3),
ADD COLUMN     "aiExtractionConfidence" DOUBLE PRECISION,
ADD COLUMN     "aiExtractionNotes" TEXT;
