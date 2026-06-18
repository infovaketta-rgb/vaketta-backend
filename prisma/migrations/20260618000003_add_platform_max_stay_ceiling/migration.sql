-- Platform-wide max-stay ceiling. Live source of truth for the OOM crash cap —
-- no per-hotel HotelConfig.maxStayNights (nor any superadmin write) may exceed
-- it. Superadmin-editable. HARD_MAX_STAY_NIGHTS is the in-code fallback used only
-- if this singleton PlatformSettings row is missing.
ALTER TABLE "PlatformSettings"
  ADD COLUMN IF NOT EXISTS "maxStayNightsCeiling" INTEGER NOT NULL DEFAULT 3650;
