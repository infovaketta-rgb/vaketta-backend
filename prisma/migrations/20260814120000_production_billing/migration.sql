-- Production-grade billing.
--
-- Ordering matters and is load-bearing:
--   1. enums                        (referenced by every later step)
--   2. Hotel.subscriptionStatus     String -> enum, so step 4 can copy from it
--   3. money Float -> Int           (documented as minor units all along)
--   4. Subscription.status backfill (must precede the partial unique index)
--   5. Invoice / Payment / AuditLog
--   6. PlatformSettings billing config
--
-- Deliberately NOT done here: assigning a trial end date to the "free forever"
-- hotels (subscriptionStatus 'trial' + billingEndDate IS NULL). Those are live
-- tenants currently receiving unlimited service; dating them in a migration
-- would suspend them without warning. See scripts/billingBackfillReport.ts.

-- ── 1. Enums ────────────────────────────────────────────────────────────────
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELED');
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

-- ── 2. Hotel.subscriptionStatus: String -> SubscriptionStatus ───────────────
-- Only three values were ever written ('trial' | 'active' | 'expired'), but the
-- column was an unconstrained String so anything could be in there. Unknown
-- values map to EXPIRED rather than silently becoming ACTIVE — fail closed.
ALTER TABLE "Hotel" ALTER COLUMN "subscriptionStatus" DROP DEFAULT;

ALTER TABLE "Hotel"
  ALTER COLUMN "subscriptionStatus" TYPE "SubscriptionStatus"
  USING (
    CASE lower("subscriptionStatus")
      WHEN 'trial'   THEN 'TRIALING'
      WHEN 'active'  THEN 'ACTIVE'
      WHEN 'expired' THEN 'EXPIRED'
      ELSE 'EXPIRED'
    END
  )::"SubscriptionStatus";

ALTER TABLE "Hotel" ALTER COLUMN "subscriptionStatus" SET DEFAULT 'TRIALING';

-- The 30-min expiry/renewal cron sweeps on exactly this pair.
CREATE INDEX "Hotel_subscriptionStatus_billingEndDate_idx"
  ON "Hotel"("subscriptionStatus", "billingEndDate");

-- ── 3. Money: Float -> Int (minor units) ────────────────────────────────────
-- Values are already whole cents/paise; ROUND is a safety net for any row that
-- picked up float drift while the columns were DOUBLE PRECISION.
ALTER TABLE "Plan"
  ALTER COLUMN "priceMonthly"            TYPE INTEGER USING ROUND("priceMonthly")::integer,
  ALTER COLUMN "extraConversationCharge" TYPE INTEGER USING ROUND("extraConversationCharge")::integer,
  ALTER COLUMN "extraAiReplyCharge"      TYPE INTEGER USING ROUND("extraAiReplyCharge")::integer;

ALTER TABLE "Subscription"
  ALTER COLUMN "price"                   TYPE INTEGER USING ROUND("price")::integer,
  ALTER COLUMN "extraConversationCharge" TYPE INTEGER USING ROUND("extraConversationCharge")::integer,
  ALTER COLUMN "extraAiReplyCharge"      TYPE INTEGER USING ROUND("extraAiReplyCharge")::integer;

-- ── 3b. Plan.country ────────────────────────────────────────────────────────
-- The admin Plans UI has always sent and rendered this field; the column never
-- existed, so the controller dropped it and every plan was silently global.
ALTER TABLE "Plan" ADD COLUMN "country" TEXT NOT NULL DEFAULT 'ALL';
CREATE INDEX "Plan_country_isActive_idx" ON "Plan"("country", "isActive");

-- ── 4. Subscription: lifecycle columns + the one-live-row invariant ─────────
ALTER TABLE "Subscription"
  ADD COLUMN "status"                 "SubscriptionStatus" NOT NULL DEFAULT 'CANCELED',
  ADD COLUMN "autoRenew"              BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "canceledAt"             TIMESTAMP(3),
  ADD COLUMN "provider"               TEXT,
  ADD COLUMN "providerSubscriptionId" TEXT,
  ADD COLUMN "updatedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: the table was an append-only snapshot log, so a hotel can have many
-- rows. Exactly one — the newest — becomes the live subscription and inherits
-- the hotel's status; every older row stays CANCELED (the column default).
WITH latest AS (
  SELECT DISTINCT ON ("hotelId") "id", "hotelId"
  FROM "Subscription"
  ORDER BY "hotelId", "createdAt" DESC, "id" DESC
)
UPDATE "Subscription" s
SET "status"     = h."subscriptionStatus",
    "canceledAt" = NULL
FROM latest l
JOIN "Hotel" h ON h."id" = l."hotelId"
WHERE s."id" = l."id";

-- Stamp the superseded rows so the history is honest about when they ended.
UPDATE "Subscription"
SET "canceledAt" = COALESCE("endDate", "createdAt")
WHERE "status" = 'CANCELED' AND "canceledAt" IS NULL;

ALTER TABLE "Subscription" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

CREATE INDEX "Subscription_hotelId_status_idx"    ON "Subscription"("hotelId", "status");
CREATE INDEX "Subscription_hotelId_createdAt_idx" ON "Subscription"("hotelId", "createdAt");
CREATE INDEX "Subscription_status_endDate_idx"    ON "Subscription"("status", "endDate");

-- The real guarantee that a hotel can never hold two live subscriptions.
-- Prisma cannot express a partial unique index, so it lives here as raw SQL;
-- the backfill above is what makes it creatable.
CREATE UNIQUE INDEX "Subscription_one_live_per_hotel"
  ON "Subscription"("hotelId")
  WHERE "status" IN ('TRIALING', 'ACTIVE', 'PAST_DUE');

-- ── 5. Invoice / Payment / AuditLog ─────────────────────────────────────────
CREATE TABLE "Invoice" (
  "id"                TEXT NOT NULL,
  "hotelId"           TEXT NOT NULL,
  "subscriptionId"    TEXT,
  "number"            TEXT NOT NULL,
  "status"            "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
  "currency"          TEXT NOT NULL,
  "subtotal"          INTEGER NOT NULL,
  "overageTotal"      INTEGER NOT NULL DEFAULT 0,
  "total"             INTEGER NOT NULL,
  "amountPaid"        INTEGER NOT NULL DEFAULT 0,
  "periodStart"       TIMESTAMP(3) NOT NULL,
  "periodEnd"         TIMESTAMP(3) NOT NULL,
  "issuedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueAt"             TIMESTAMP(3) NOT NULL,
  "paidAt"            TIMESTAMP(3),
  "lineItems"         JSONB NOT NULL,
  "notes"             TEXT,
  "provider"          TEXT,
  "providerInvoiceId" TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");
-- The renewal cron's idempotency key: one invoice per hotel per period, so a
-- re-run, restart, or concurrent tick can never double-bill.
CREATE UNIQUE INDEX "Invoice_hotelId_periodStart_key" ON "Invoice"("hotelId", "periodStart");
CREATE INDEX "Invoice_hotelId_issuedAt_idx" ON "Invoice"("hotelId", "issuedAt");
CREATE INDEX "Invoice_status_dueAt_idx"     ON "Invoice"("status", "dueAt");

CREATE TABLE "Payment" (
  "id"                TEXT NOT NULL,
  "hotelId"           TEXT NOT NULL,
  "invoiceId"         TEXT NOT NULL,
  "status"            "PaymentStatus" NOT NULL DEFAULT 'SUCCEEDED',
  "currency"          TEXT NOT NULL,
  "amount"            INTEGER NOT NULL,
  "method"            TEXT NOT NULL DEFAULT 'manual_bank_transfer',
  "provider"          TEXT,
  "providerPaymentId" TEXT,
  "recordedByAdminId" TEXT,
  "reference"         TEXT,
  "notes"             TEXT,
  "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- Unique so a future gateway webhook is idempotent on redelivery.
CREATE UNIQUE INDEX "Payment_providerPaymentId_key" ON "Payment"("providerPaymentId");
CREATE INDEX "Payment_hotelId_receivedAt_idx" ON "Payment"("hotelId", "receivedAt");
CREATE INDEX "Payment_invoiceId_idx"          ON "Payment"("invoiceId");

CREATE TABLE "AuditLog" (
  "id"        TEXT NOT NULL,
  "category"  TEXT NOT NULL,
  "type"      TEXT NOT NULL,
  "actorType" TEXT NOT NULL DEFAULT 'ADMIN',
  "actorId"   TEXT,
  "hotelId"   TEXT,
  "data"      JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_hotelId_createdAt_idx"       ON "AuditLog"("hotelId", "createdAt");
CREATE INDEX "AuditLog_category_type_createdAt_idx" ON "AuditLog"("category", "type", "createdAt");
CREATE INDEX "AuditLog_createdAt_idx"               ON "AuditLog"("createdAt");

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 6. PlatformSettings billing config ──────────────────────────────────────
-- One timezone for every period boundary and UsageRecord month key. Previously
-- each call site built "YYYY-MM" from server-local time, so usage re-bucketed
-- whenever the container TZ moved and two sites could disagree.
ALTER TABLE "PlatformSettings"
  ADD COLUMN "billingTimezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN "gracePeriodDays" INTEGER NOT NULL DEFAULT 7;

-- startTrial hardcoded currency 'USD' onto the trial snapshot, so a ₹-priced
-- product showed dollar amounts on the hotel's Subscription page for the whole
-- trial. Cosmetic (trials are free) but visible to every new customer.
ALTER TABLE "TrialConfig" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'INR';

-- ── 7. HotelConfig locale ───────────────────────────────────────────────────
-- The admin hotel-detail page has always PATCHed `config: { country, currency,
-- dateFormat }`, but these columns never existed and updateHotelHandler
-- destructured only { name, phone } — the payload was silently discarded, same
-- class of bug as Plan.country. `country` is what scopes which plans a hotel is
-- offered, so country targeting needs it.
ALTER TABLE "HotelConfig"
  ADD COLUMN "country"    TEXT NOT NULL DEFAULT '',
  ADD COLUMN "currency"   TEXT NOT NULL DEFAULT 'INR',
  ADD COLUMN "dateFormat" TEXT NOT NULL DEFAULT 'DD/MM/YYYY';
