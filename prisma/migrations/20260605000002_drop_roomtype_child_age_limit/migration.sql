-- childAgeLimit is now hotel-wide (HotelConfig.childAgeLimit). Drop the per-room
-- column. Idempotent so a re-run on a DB where it's already gone is a no-op.
ALTER TABLE "RoomType"
  DROP COLUMN IF EXISTS "childAgeLimit";
