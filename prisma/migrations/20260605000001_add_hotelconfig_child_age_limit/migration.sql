-- Hotel-wide child age threshold. A child older than this is counted as an adult
-- for occupancy/allocation. Replaces the deprecated per-RoomType childAgeLimit.
ALTER TABLE "HotelConfig"
  ADD COLUMN IF NOT EXISTS "childAgeLimit" INTEGER NOT NULL DEFAULT 12;
