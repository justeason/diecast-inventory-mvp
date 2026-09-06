-- AlterTable
ALTER TABLE "CustomerSession" ADD COLUMN     "authMethod" TEXT;

-- CreateTable
CREATE TABLE "CustomerCredential" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCredential_profileId_key" ON "CustomerCredential"("profileId");

-- AddForeignKey
ALTER TABLE "CustomerCredential" ADD CONSTRAINT "CustomerCredential_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

