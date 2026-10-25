-- PHASE 1 of 2 — EXPAND. Apply BEFORE deploying the new application code.
--
-- Anchored billing periods + billing-period usage buckets.
--
-- This phase is PURELY ADDITIVE and is safe to run while the CURRENT code is
-- still serving traffic:
--   * the four new columns are nullable and the old code never reads them;
--   * the legacy `UsageRecord_hotelId_month_key` is deliberately KEPT, because
--     the currently-deployed code upserts on `(hotelId, month)` — Prisma
--     compiles that to `INSERT ... ON CONFLICT (hotelId, month)`, which ERRORS
--     outright without a matching unique index. Dropping it here would not
--     merely weaken a race guard, it would break metering for every hotel until
--     the new code shipped. It is dropped in phase 2, AFTER the deploy.
--   * no table is dropped, truncated or recreated;
--   * no column is dropped or retyped;
--   * no counter is reset — the backfill only fills columns that are NULL;
--   * no invoice is created, altered or deleted.
--
-- Both phases are individually reversible: phase 1 by dropping the new index and
-- columns, phase 2 by recreating the legacy index.

-- ── Subscription: the recurring anchor + the scheduled-plan seam ─────────────

-- Day-of-month (1–31) this subscription recurs on, in PlatformSettings.billingTimezone.
-- Nullable: existing rows are backfilled by scripts/billingAnchorBackfill.ts,
-- and until then the runtime derives the same value from the period boundaries.
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "billingAnchorDay" INTEGER;

-- Plan that takes effect at exactly a trial's exclusive end. Soft reference,
-- matching the existing `planId` convention — deliberately no FK, so retiring a
-- plan can never block a subscription write.
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "scheduledPlanId" TEXT;

-- ── UsageRecord: bucket identity moves from the month to the period ──────────

ALTER TABLE "UsageRecord" ADD COLUMN IF NOT EXISTS "periodStart" TIMESTAMP(3);
ALTER TABLE "UsageRecord" ADD COLUMN IF NOT EXISTS "periodEnd" TIMESTAMP(3);

-- `month` stays, and stays populated: it is the calendar label platform-wide
-- analytics group by. It simply stops being the row's identity.
CREATE INDEX IF NOT EXISTS "UsageRecord_hotelId_month_idx" ON "UsageRecord"("hotelId", "month");

-- Coarse backfill: every existing row keeps the calendar month it already
-- represents. Runs BEFORE the unique index so no row is left NULL by accident.
-- Rows belonging to a hotel's CURRENT period are then corrected to that
-- period's exact boundaries by scripts/billingAnchorBackfill.ts, which uses the
-- same timezone-aware helpers the runtime does — that script is what guarantees
-- the in-flight counter keeps being found, i.e. no allowance is silently reset
-- and no usage is double-counted.
--
-- `WHERE "periodStart" IS NULL` makes this idempotent and non-destructive: a
-- re-run can never overwrite a value the script has already refined.
UPDATE "UsageRecord"
SET "periodStart" = ("month" || '-01')::date::timestamp,
    "periodEnd"   = (("month" || '-01')::date + INTERVAL '1 month')::timestamp
WHERE "periodStart" IS NULL
  AND "month" ~ '^[0-9]{4}-[0-9]{2}$';

-- The new identity. Postgres unique indexes never treat two NULLs as equal, so
-- any row with a malformed `month` (left NULL above) is exempt rather than
-- blocking the index. This must exist BEFORE the new code deploys: its upserts
-- target `(hotelId, periodStart)` via ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS "UsageRecord_hotelId_periodStart_key"
  ON "UsageRecord"("hotelId", "periodStart");
