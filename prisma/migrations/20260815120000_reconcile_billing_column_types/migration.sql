-- Reconcile the three column types that were reverted by an emergency hotfix.
--
-- BACKGROUND
-- ----------
-- 20260814120000_production_billing was applied to the shared Supabase database
-- while the deployed backend was still running pre-billing code. That old code's
-- Prisma Client had `Hotel.subscriptionStatus` compiled in as a plain String, so
-- every read of it started failing:
--
--   Error converting field "subscriptionStatus" of expected non-nullable type
--   "String", found incompatible value of "ACTIVE".
--
-- `loginService` includes `hotel` on its user lookup, so that error surfaced as a
-- 401 and the login page rendered it as "Invalid email or password" — a full
-- login outage for every hotel. An emergency hotfix reverted exactly three things
-- to restore compatibility with the still-deployed old code:
--
--   • Hotel.subscriptionStatus   enum  -> text  (values lower-cased)
--   • Plan money columns         int   -> float
--   • Subscription money columns int   -> float
--
-- Everything else from that migration (Invoice/Payment/AuditLog tables, the enum
-- TYPES themselves, Plan.country, Subscription lifecycle columns, HotelConfig
-- locale columns, PlatformSettings billing columns, the partial unique index)
-- was left in place and is still applied.
--
-- This migration re-applies only the reverted three, so the database matches
-- schema.prisma again. Run it as part of deploying the billing backend.
--
-- WHY A NEW MIGRATION rather than `migrate resolve --rolled-back` on the
-- original: the original starts with CREATE TYPE, and those types still exist —
-- re-running it would abort immediately.
--
-- Every step is guarded on the column's CURRENT type, so this is a no-op on a
-- database where 20260814120000 applied cleanly and was never hotfixed (e.g. a
-- fresh environment). Safe to run anywhere, and safe to run twice.

-- 1. Hotel.subscriptionStatus: text -> SubscriptionStatus
--    Maps the lower-case values the hotfix wrote back to enum labels. Anything
--    unrecognised becomes EXPIRED — failing closed, since the alternative is
--    granting service on a value we cannot interpret.
DO $$
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'Hotel' AND column_name = 'subscriptionStatus'
  ) = 'text' THEN

    ALTER TABLE "Hotel" ALTER COLUMN "subscriptionStatus" DROP DEFAULT;

    ALTER TABLE "Hotel"
      ALTER COLUMN "subscriptionStatus" TYPE "SubscriptionStatus"
      USING (
        CASE lower("subscriptionStatus")
          WHEN 'trial'    THEN 'TRIALING'
          WHEN 'trialing' THEN 'TRIALING'
          WHEN 'active'   THEN 'ACTIVE'
          WHEN 'past_due' THEN 'PAST_DUE'
          WHEN 'expired'  THEN 'EXPIRED'
          WHEN 'canceled' THEN 'CANCELED'
          ELSE 'EXPIRED'
        END
      )::"SubscriptionStatus";

    ALTER TABLE "Hotel" ALTER COLUMN "subscriptionStatus" SET DEFAULT 'TRIALING';
  END IF;
END $$;

-- 2. Plan money columns: double precision -> integer minor units.
--    ROUND guards against float drift picked up while the columns were floats.
DO $$
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'Plan' AND column_name = 'priceMonthly'
  ) = 'double precision' THEN

    ALTER TABLE "Plan"
      ALTER COLUMN "priceMonthly"            TYPE INTEGER USING ROUND("priceMonthly")::integer,
      ALTER COLUMN "extraConversationCharge" TYPE INTEGER USING ROUND("extraConversationCharge")::integer,
      ALTER COLUMN "extraAiReplyCharge"      TYPE INTEGER USING ROUND("extraAiReplyCharge")::integer;
  END IF;
END $$;

-- 3. Subscription money columns: same treatment.
DO $$
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'Subscription' AND column_name = 'price'
  ) = 'double precision' THEN

    ALTER TABLE "Subscription"
      ALTER COLUMN "price"                   TYPE INTEGER USING ROUND("price")::integer,
      ALTER COLUMN "extraConversationCharge" TYPE INTEGER USING ROUND("extraConversationCharge")::integer,
      ALTER COLUMN "extraAiReplyCharge"      TYPE INTEGER USING ROUND("extraAiReplyCharge")::integer;
  END IF;
END $$;
