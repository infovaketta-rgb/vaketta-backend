-- Composite unique constraint on (hotelId, wamid) — makes the history importer
-- and status-webhook dedup race-safe at the database level instead of relying
-- solely on an application-level findFirst-then-create check. NULL wamids
-- (staff-composed sends, template sends, etc.) are exempt from Postgres
-- uniqueness — a unique index never treats two NULLs as equal.
--
-- Composite (hotelId, wamid), NOT a global unique on wamid — the same wamid
-- string is only guaranteed unique within Meta's scope for one WABA/phone
-- number; it must not collide across different hotels.

-- Pre-flight: if any (hotelId, wamid) pairs already have duplicate rows (the
-- exact bug this migration fixes), the unique index below would fail to
-- create. Keep the earliest row per pair and drop the rest before adding the
-- constraint, so this migration is safe to run against existing data that may
-- already contain duplicates from prior (non-idempotent) history imports.
DELETE FROM "Message" m
USING "Message" keep
WHERE m."wamid" IS NOT NULL
  AND keep."wamid" IS NOT NULL
  AND m."hotelId" = keep."hotelId"
  AND m."wamid" = keep."wamid"
  AND m."id" <> keep."id"
  AND (m."timestamp", m."id") > (keep."timestamp", keep."id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_hotelId_wamid_key" ON "Message"("hotelId", "wamid");
