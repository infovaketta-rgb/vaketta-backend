-- Manual / offline payment claims: submission provenance, review provenance,
-- and proof-of-payment.
--
-- ADDITIVE AND NON-LOCKING. Every column is nullable with no default, so
-- Postgres records them in the catalog without rewriting the table and no
-- existing Payment row is touched or backfilled. Nothing here changes what any
-- current payment means:
--
--   * gateway payments (Razorpay) leave all six columns NULL, exactly as today;
--   * admin-recorded payments keep using `recordedByAdminId` and leave the new
--     review columns NULL until someone actually reviews something;
--   * `PaymentStatus` is UNCHANGED — PENDING/SUCCEEDED/FAILED/REFUNDED already
--     express the whole claim lifecycle, so there is no enum migration.
--
-- WHY `reviewedByAdminId` IS NOT `recordedByAdminId`: the admin who enters a
-- claim on a hotel's behalf and the admin who verifies the money arrived may be
-- different people. Reusing one column would collapse that distinction and
-- defeat the point of having a review step at all.

ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "submittedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedByAdminId" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimedPaidAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "proofUrl"          TEXT,
  ADD COLUMN IF NOT EXISTS "proofKey"          TEXT;

-- The admin review queue: PENDING claims, oldest first.
--
-- `receivedAt` cannot serve this: transitionPayment REWRITES it to now() on
-- approval, so it is the settlement time, not the submission time. `createdAt`
-- is set once at insert and never moves, which is what a queue must sort on.
CREATE INDEX IF NOT EXISTS "Payment_status_createdAt_idx"
  ON "Payment"("status", "createdAt");
