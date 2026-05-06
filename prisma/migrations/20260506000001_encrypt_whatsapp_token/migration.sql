-- Rename plain-text token column to encrypted equivalent
ALTER TABLE "HotelConfig"
    RENAME COLUMN "metaAccessToken" TO "metaAccessTokenEncrypted";

-- Track when the WhatsApp token was last set via Embedded Signup or manual save
ALTER TABLE "HotelConfig"
    ADD COLUMN IF NOT EXISTS "metaTokenUpdatedAt" TIMESTAMP(3);
