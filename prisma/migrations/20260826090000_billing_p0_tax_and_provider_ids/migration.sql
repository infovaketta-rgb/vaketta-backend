-- P0 billing corrections: tax columns, gateway idempotency keys, and a real
-- Payment status lifecycle.
--
-- ADDITIVE AND NON-LOCKING BY DESIGN. Every new column is nullable or carries a
-- DEFAULT, so no table rewrite is required and no existing row is touched:
--
--   * Invoice.taxTotal / taxRate default 0, so `total` for every invoice already
--     issued stays exactly `subtotal + overageTotal`. There is no backfill
--     because there is nothing to correct — historical totals are already right
--     under the old formula, and the new formula reduces to the old one when
--     taxTotal is 0.
--   * Plan.taxRate defaults 0, so no plan starts charging tax as a side effect
--     of this migration. A superadmin opts each plan in explicitly.
--   * Payment's new DEFAULT applies only to future inserts; existing rows keep
--     whatever status they hold.
--
-- The unique indexes are all on NULLABLE gateway columns. Postgres never treats
-- two NULLs as equal, so every manually-billed row (all of them today) is exempt
-- — the same exemption Message.wamid's composite unique already relies on.
-- They exist now, before any gateway integration, so that the FIRST webhook
-- ever delivered lands against a schema that can already reject a duplicate.

-- ── Plan: tax configuration ─────────────────────────────────────────────────
ALTER TABLE "Plan"
  ADD COLUMN IF NOT EXISTS "taxRate"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "taxLabel" TEXT;

-- ── Subscription: snapshotted tax terms ─────────────────────────────────────
-- Snapshotted for exactly the reason `price` and the limits already are: a
-- superadmin changing a Plan's tax rate must not alter what a hotel owes for a
-- period it is already inside. `renewDueSubscriptions` reads these columns, not
-- the live Plan.
ALTER TABLE "Subscription"
  ADD COLUMN IF NOT EXISTS "taxRate"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "taxLabel" TEXT;

-- ── Invoice: snapshotted tax + gateway ids ──────────────────────────────────
-- taxRate/taxLabel are SNAPSHOTTED here rather than read through to Plan for
-- the same reason Subscription snapshots its terms: editing a plan must never
-- retroactively re-tax an invoice that has already been sent to a customer.
ALTER TABLE "Invoice"
  ADD COLUMN IF NOT EXISTS "taxTotal"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "taxRate"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "taxLabel"        TEXT,
  ADD COLUMN IF NOT EXISTS "providerOrderId" TEXT;

-- ── Payment: status lifecycle, gateway order id, failure reason ─────────────
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "providerOrderId" TEXT,
  ADD COLUMN IF NOT EXISTS "failureReason"   TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- PENDING is the safe default: a caller that omits a status now under-credits
-- (visible and fixable) rather than silently recording money that never arrived.
-- Existing rows are unaffected — a DEFAULT change never rewrites stored values.
ALTER TABLE "Payment" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- ── Gateway idempotency keys ────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_providerInvoiceId_key"
  ON "Invoice"("providerInvoiceId");
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_providerOrderId_key"
  ON "Invoice"("providerOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_providerOrderId_key"
  ON "Payment"("providerOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_providerSubscriptionId_key"
  ON "Subscription"("providerSubscriptionId");

-- ── Payment lookup indexes ──────────────────────────────────────────────────
-- Both support "what does this hotel still owe" and the future admin
-- verification queue, which filter on status rather than on receivedAt alone.
CREATE INDEX IF NOT EXISTS "Payment_hotelId_status_idx"   ON "Payment"("hotelId", "status");
CREATE INDEX IF NOT EXISTS "Payment_status_receivedAt_idx" ON "Payment"("status", "receivedAt");
