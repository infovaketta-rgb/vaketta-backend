-- Remove the unused PlatformSettings.instagramAppId column.
-- The Instagram connect flow now uses instagramConfigId (Facebook Login for
-- Business config_id); the FB SDK App ID comes from the NEXT_PUBLIC_META_APP_ID
-- build-time env var, so this DB field was never read by the connect flow.
ALTER TABLE "PlatformSettings" DROP COLUMN IF EXISTS "instagramAppId";
