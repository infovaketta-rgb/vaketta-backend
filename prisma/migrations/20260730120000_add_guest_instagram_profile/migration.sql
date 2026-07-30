-- AlterTable
-- All columns nullable with no defaults — additive, non-locking change.
ALTER TABLE "Guest" ADD COLUMN "igName" TEXT,
ADD COLUMN "igUsername" TEXT,
ADD COLUMN "igProfilePicUrl" TEXT,
ADD COLUMN "igProfilePicKey" TEXT,
ADD COLUMN "igProfilePicHash" TEXT,
ADD COLUMN "igFollowerCount" INTEGER,
ADD COLUMN "igFollowsBusiness" BOOLEAN,
ADD COLUMN "igBusinessFollows" BOOLEAN,
ADD COLUMN "igProfileFetchedAt" TIMESTAMP(3),
ADD COLUMN "igProfileStatus" TEXT;

-- CreateIndex
CREATE INDEX "Guest_hotelId_igProfileFetchedAt_idx" ON "Guest"("hotelId", "igProfileFetchedAt");
