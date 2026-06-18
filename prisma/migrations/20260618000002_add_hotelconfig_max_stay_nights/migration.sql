-- Max nights a guest may book in one stay. Gates create_booking BEFORE any
-- availability query — an absurd checkout date (e.g. ~2000 years out) used to
-- OOM the server. Admin-configurable (1–3650); 3650 is a hard crash ceiling.
ALTER TABLE "HotelConfig"
  ADD COLUMN IF NOT EXISTS "maxStayNights" INTEGER NOT NULL DEFAULT 60;
