/**
 * usage.service.ts
 *
 * Metering and quota enforcement.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * 1. **`isConversationOverQuota` conflated two different things.** It returned
 *    `true` both when a hotel was over its allowance AND when its subscription
 *    had lapsed, so the log line said "conversation quota exceeded" for what was
 *    actually an unpaid account. Worse, the single early-return it drove in
 *    message.service sat ABOVE the staff-notification block, so a suspended
 *    hotel received guest messages with no bot reply AND no staff alert. Now
 *    there are two predicates: `isSuspended` and `isOverQuota`.
 *
 * 2. **`aiReplyLimit` was never enforced.** It was stored, snapshotted onto
 *    every subscription, and displayed — but never once compared against
 *    `aiRepliesUsed`. Any hotel on any plan could burn unlimited LLM spend.
 *    `isAIReplyOverQuota` closes that.
 *
 * 3. **Month keys were server-local.** `currentMonth()` built "YYYY-MM" from
 *    `new Date()`, and analytics.controller had its own copy of the same
 *    expression. Usage re-bucketed if the container TZ moved and the two sites
 *    could disagree. Both now go through `billing/period.monthKey` with the
 *    platform billing timezone.
 *
 * 4. **"Current subscription" is `getCurrentSubscription`**, not a `findFirst`
 *    ordered by `startDate` — which used to disagree with billing.service's
 *    `createdAt` ordering because start dates were back-dated.
 *
 * 5. **Buckets follow the BILLING PERIOD, not the calendar month.** A hotel
 *    billed 15 Aug → 14 Sep had its allowance reset on the 1st — halfway
 *    through its own cycle — and the renewal invoice read a calendar month that
 *    included traffic from before the period started, so trial usage was billed
 *    as paid overage on the first invoice. The bucket key is now the period's
 *    own `periodStart`. `month` is still written, as a calendar label for
 *    platform analytics.
 *
 * FAILURE POLICY: quota checks fail OPEN on a DB/Redis error (never silence a
 * paying hotel's bot because of an infrastructure blip) but fail CLOSED on a
 * genuine limit hit. Period resolution falls back to the calendar month, which
 * is what hotels with no subscription row have always used.
 */
import { Prisma, SubscriptionStatus } from "@prisma/client";
import prisma from "../db/connect";
import { logger } from "../utils/logger";
import { monthKey, startOfMonthInTZ, startOfNextMonthInTZ } from "../billing/period";
import { getBillingConfig, getEffectiveSubscription, getSubscriptionStatus } from "./billing.service";

const log = logger.child({ service: "usage" });

/** The current calendar month key, in the platform's billing timezone. */
export async function currentMonth(now: Date = new Date()): Promise<string> {
  const { timezone } = await getBillingConfig();
  return monthKey(now, timezone);
}

export type UsagePeriod = {
  /** Bucket identity — the billing period this usage belongs to. */
  periodStart: Date;
  periodEnd: Date;
  /** Calendar label, for platform-wide analytics. */
  month: string;
};

/**
 * The bucket usage should be metered into right now.
 *
 * Comes from the hotel's EFFECTIVE period, so metering rolls over at the same
 * instant billing does — including when the cron has not yet materialised the
 * roll. Hotels with no subscription (legacy "free forever") keep calendar
 * months, which is exactly what they had before.
 */
export async function resolveUsagePeriod(hotelId: string, now: Date = new Date()): Promise<UsagePeriod> {
  const { timezone } = await getBillingConfig();

  try {
    const effective = await getEffectiveSubscription(hotelId, now);
    if (effective?.periodEnd) {
      return {
        periodStart: effective.periodStart,
        periodEnd: effective.periodEnd,
        month: monthKey(effective.periodStart, timezone),
      };
    }
  } catch (err) {
    log.warn({ err, hotelId }, "usage period resolution failed — falling back to the calendar month");
  }

  return {
    periodStart: startOfMonthInTZ(now, timezone),
    periodEnd: startOfNextMonthInTZ(now, timezone),
    month: monthKey(now, timezone),
  };
}

// ── Increment ────────────────────────────────────────────────────────────────

/**
 * Did this fail on the LEGACY `(hotelId, month)` unique index?
 *
 * TRANSITIONAL — see migration 20260815140000. Between the expand migration and
 * the contract one, the new code runs while that index still exists.
 */
function isLegacyMonthConflict(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002" &&
    String((err.meta as { target?: unknown } | undefined)?.target ?? "").includes("month")
  );
}

/**
 * Increment one meter in the hotel's current billing-period bucket.
 *
 * The bucket is keyed by `periodStart`. While the legacy `(hotelId, month)`
 * unique index still exists (the window between the expand and contract
 * migrations), a hotel whose trial converts mid-month has TWO periods starting
 * in the same calendar month, and the second insert trips that index. Rather
 * than merging the paid period's usage into the trial's row — which is exactly
 * the mis-billing this work removed — the row is relabelled with the month its
 * period ENDS in, which is both free of the collision and a fairer label.
 *
 * Metering must never break the message pipeline, so an unresolvable collision
 * is logged and dropped rather than thrown. Delete this fallback once the
 * contract migration has been applied everywhere.
 */
async function upsertUsageCounter(
  hotelId: string,
  meter: "conversationsUsed" | "aiRepliesUsed",
): Promise<void> {
  const { periodStart, periodEnd, month } = await resolveUsagePeriod(hotelId);

  const write = (monthLabel: string) =>
    prisma.usageRecord.upsert({
      where: { hotelId_periodStart: { hotelId, periodStart } },
      update: { [meter]: { increment: 1 } },
      create: {
        hotelId,
        month: monthLabel,
        periodStart,
        periodEnd,
        conversationsUsed: meter === "conversationsUsed" ? 1 : 0,
        aiRepliesUsed: meter === "aiRepliesUsed" ? 1 : 0,
      },
    });

  try {
    await write(month);
    return;
  } catch (err) {
    if (!isLegacyMonthConflict(err)) throw err;
  }

  const { timezone } = await getBillingConfig();
  // The last instant of the period — its own month, not the previous bucket's.
  const fallbackMonth = monthKey(new Date(periodEnd.getTime() - 1), timezone);

  try {
    await write(fallbackMonth);
  } catch (err) {
    if (!isLegacyMonthConflict(err)) throw err;
    log.warn(
      { hotelId, periodStart, month, fallbackMonth },
      "usage bucket blocked by the legacy (hotelId, month) index — metering event dropped; apply the contract migration",
    );
  }
}

export async function incrementConversationUsage(hotelId: string): Promise<void> {
  await upsertUsageCounter(hotelId, "conversationsUsed");
}

export async function incrementAIUsage(hotelId: string): Promise<void> {
  await upsertUsageCounter(hotelId, "aiRepliesUsed");
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function getCurrentUsage(hotelId: string, now: Date = new Date()) {
  const period = await resolveUsagePeriod(hotelId, now);
  const row = await prisma.usageRecord.findUnique({
    where: { hotelId_periodStart: { hotelId, periodStart: period.periodStart } },
  });

  return (
    row ?? {
      hotelId,
      month: period.month,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      conversationsUsed: 0,
      aiRepliesUsed: 0,
    }
  );
}

export async function getUsageHistory(hotelId: string, months = 6) {
  const records = await prisma.usageRecord.findMany({
    where: { hotelId },
    // periodStart is the true ordering; month is the tiebreak for pre-backfill
    // rows, where it is still the only thing populated.
    orderBy: [{ periodStart: "desc" }, { month: "desc" }],
    take: months,
  });
  return records.reverse(); // oldest → newest for charts
}

// ── Entitlement vs quota — two distinct questions ────────────────────────────

/**
 * Is the hotel's subscription lapsed?
 *
 * This is about ENTITLEMENT (did they pay), not consumption. PAST_DUE is
 * deliberately NOT suspended: that is the grace window, where service continues
 * while dunning runs.
 *
 * Fails open — an unreadable status must not silence a paying hotel.
 */
export async function isSuspended(hotelId: string): Promise<boolean> {
  try {
    const status = await getSubscriptionStatus(hotelId);
    if (status === null) return false; // unknown hotel — not our call to make here
    return status === SubscriptionStatus.EXPIRED || status === SubscriptionStatus.CANCELED;
  } catch (err) {
    log.error({ err, hotelId }, "isSuspended check failed — failing open");
    return false;
  }
}

type Meter = "conversations" | "aiReplies";

/**
 * Shared quota check. `limit === 0` means unlimited (the convention used by the
 * schema comments, the admin Plans UI, and billing/overage.ts).
 *
 * LIMITS AND USAGE COME FROM THE SAME READ. Limits used to be taken from the
 * live subscription row while usage came from the effective period. Between a
 * trial's boundary and the cron materialising the conversion those disagree:
 * the trial's limits would be applied to the paid period's fresh counter. Both
 * now come from `getEffectiveSubscription`, which reports the SCHEDULED plan's
 * terms the moment a trial converts. As a bonus the hot path loses a per-message
 * Postgres query — the effective state is Redis-cached.
 *
 * A hotel with NO subscription row returns false (unlimited). That is the
 * legacy "free forever" state — see billingBackfillReport.ts. It is left as-is
 * deliberately: silently metering tenants who were never given a subscription
 * would cut off live customers with no warning.
 */
async function isOverMeter(hotelId: string, meter: Meter): Promise<boolean> {
  try {
    const now = new Date();
    const effective = await getEffectiveSubscription(hotelId, now);
    if (!effective?.terms) return false;

    const limit =
      meter === "conversations" ? effective.terms.conversationLimit : effective.terms.aiReplyLimit;
    if (!Number.isFinite(limit) || limit <= 0) return false; // 0 = unlimited

    const usage = await getCurrentUsage(hotelId, now);
    const used = meter === "conversations" ? usage.conversationsUsed : usage.aiRepliesUsed;
    return used >= limit;
  } catch (err) {
    log.error({ err, hotelId, meter }, "quota check failed — failing open");
    return false;
  }
}

/** Has the hotel exhausted its monthly conversation allowance? */
export async function isOverQuota(hotelId: string): Promise<boolean> {
  return isOverMeter(hotelId, "conversations");
}

/**
 * Has the hotel exhausted its monthly AI-reply allowance?
 *
 * Gates `getAIReply` in botEngine. Over the limit the bot falls through to its
 * non-AI path rather than going silent — the guest still gets the menu/flow.
 */
export async function isAIReplyOverQuota(hotelId: string): Promise<boolean> {
  return isOverMeter(hotelId, "aiReplies");
}

// ── Admin aggregates ─────────────────────────────────────────────────────────

export async function getPlatformUsageThisMonth() {
  const month = await currentMonth();
  const agg = await prisma.usageRecord.aggregate({
    where: { month },
    _sum: { conversationsUsed: true, aiRepliesUsed: true },
  });
  return {
    conversations: agg._sum.conversationsUsed ?? 0,
    aiReplies: agg._sum.aiRepliesUsed ?? 0,
  };
}

export async function getPlatformUsageHistory(months = 6) {
  const records = await prisma.usageRecord.groupBy({
    by: ["month"],
    _sum: { conversationsUsed: true, aiRepliesUsed: true },
    orderBy: { month: "asc" },
  });

  return records.slice(-months).map((r) => ({
    month: r.month,
    conversations: r._sum.conversationsUsed ?? 0,
    aiReplies: r._sum.aiRepliesUsed ?? 0,
  }));
}
