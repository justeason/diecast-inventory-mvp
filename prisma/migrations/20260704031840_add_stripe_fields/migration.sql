-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "stripePaymentIntentId" TEXT,
ADD COLUMN     "stripeSessionExpiresAt" TIMESTAMP(3),
ADD COLUMN     "stripeSessionId" TEXT;
