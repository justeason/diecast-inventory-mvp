-- CreateTable
CREATE TABLE "CustomerCommunityProfile" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "showOnLeaderboards" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerCommunityProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCommunityProfile_profileId_key" ON "CustomerCommunityProfile"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCommunityProfile_handle_key" ON "CustomerCommunityProfile"("handle");

-- CreateIndex
CREATE INDEX "CustomerCommunityProfile_isPublic_showOnLeaderboards_idx" ON "CustomerCommunityProfile"("isPublic", "showOnLeaderboards");

-- CreateIndex
CREATE INDEX "CustomerCommunityProfile_handle_idx" ON "CustomerCommunityProfile"("handle");

-- AddForeignKey
ALTER TABLE "CustomerCommunityProfile" ADD CONSTRAINT "CustomerCommunityProfile_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CustomerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
