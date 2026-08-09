/*
  Warnings:

  - You are about to drop the column `commissionAcceptedItemCount` on the `SellerAgreement` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "SellerAgreement" DROP COLUMN "commissionAcceptedItemCount",
ADD COLUMN     "acceptedItemCount" INTEGER;
