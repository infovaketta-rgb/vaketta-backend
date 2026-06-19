-- Add Meta API version, WhatsApp config_id, and Instagram app_id to PlatformSettings
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "metaApiVersion"   TEXT NOT NULL DEFAULT 'v25.0';
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "whatsappConfigId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "instagramAppId"   TEXT NOT NULL DEFAULT '';
