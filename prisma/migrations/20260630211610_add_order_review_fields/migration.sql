-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "adminNotes" TEXT,
ADD COLUMN     "estimatedShipping" DOUBLE PRECISION,
ADD COLUMN     "followUpNotes" TEXT;
