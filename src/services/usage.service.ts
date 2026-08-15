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
 * FAILURE POLICY: quota checks fail OPEN on a DB/Redis error (never silence a
 * paying hotel's bot because of an infrastructure blip) but fail CLOSED on a
 * genuine limit hit.
 */
import { SubscriptionStatus } from "@prisma/client";
import prisma from "../db/connect";
import { logger } from "../utils/logger";
import { monthKey } from "../billing/period";
import { getBillingConfig, getCurrentSubscription, getSubscriptionStatus } from "./billing.service";

const log = logger.child({ service: "usage" });

/** The current UsageRecord bucket, in the platform's billing timezone. */
export async function currentMonth(now: Date = new Date()): Promise<string> {
  const { timezone } = await getBillingConfig();
  return monthKey(now, timezone);
}

// ── Increment ────────────────────────────────────────────────────────────────

export async function incrementConversationUsage(hotelId: string): Promise<void> {
  const month = await currentMonth();
  await prisma.usageRecord.upsert({
    where: { hotelId_month: { hotelId, month } },
    update: { conversationsUsed: { increment: 1 } },
    create: { hotelId, month, conversationsUsed: 1, aiRepliesUsed: 0 },
  });
}

export async function incrementAIUsage(hotelId: string): Promise<void> {
  const month = await currentMonth();
  await prisma.usageRecord.upsert({
    where: { hotelId_month: { hotelId, month } },
    update: { aiRepliesUsed: { increment: 1 } },
    create: { hotelId, month, conversationsUsed: 0, aiRepliesUsed: 1 },
  });
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function getCurrentUsage(hotelId: string) {
  const month = await currentMonth();
  return (
    (await prisma.usageRecord.findUnique({
      where: { hotelId_month: { hotelId, month } },
    })) ?? { hotelId, month, conversationsUsed: 0, aiRepliesUsed: 0 }
  );
}

export async function getUsageHistory(hotelId: string, months = 6) {
  const records = await prisma.usageRecord.findMany({
    where: { hotelId },
    orderBy: { month: "desc" },
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
 * A hotel with NO subscription row returns false (unlimited). That is the
 * legacy "free forever" state — see billingBackfillReport.ts. It is left as-is
 * deliberately: silently metering tenants who were never given a subscription
 * would cut off live customers with no warning.
 */
async function isOverMeter(hotelId: string, meter: Meter): Promise<boolean> {
  try {
    const sub = await getCurrentSubscription(hotelId);
    if (!sub) return false;

    const limit = meter === "conversations" ? sub.conversationLimit : sub.aiReplyLimit;
    if (!Number.isFinite(limit) || limit <= 0) return false; // 0 = unlimited

    const usage = await getCurrentUsage(hotelId);
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
