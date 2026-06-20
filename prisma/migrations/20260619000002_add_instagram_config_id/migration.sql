-- Add Instagram Facebook-Login-for-Business config_id to PlatformSettings.
-- Used by the config_id-based FB.login() Instagram connect flow (mirrors WhatsApp
-- Embedded Signup). Empty string default — no fallback config_id; the connect flow
-- surfaces a clear error when unset rather than guessing.
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "instagramConfigId" TEXT NOT NULL DEFAULT '';
