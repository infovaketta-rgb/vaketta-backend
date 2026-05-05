-- AlterTable
ALTER TABLE "HotelConfig"
    ADD COLUMN IF NOT EXISTS "facebookPageId"      TEXT,
    ADD COLUMN IF NOT EXISTS "instagramConnectedAt" TIMESTAMP(3);
