/**
 * billing.service.ts
 *
 * Subscription lifecycle: assign, trial, renew, cancel, suspend.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * 1. **Periods no longer back-date.** `assignPlanToHotel` used
 *    `startOfMonth(now)` → `startOfNextMonth(now)`. A hotel signing up on the
 *    28th got three days of service and was billed a full month for it, then the
 *    expiry cron killed it. Periods now start at signup and the partial first
 *    period is PRORATED (billing/period.ts).
 *
 * 2. **Writes are transactional.** Assign and trial each did a `create` then a
 *    separate `update`; a partial failure left an orphan Subscription that the
 *    hotel page *displayed* while `Hotel.planId`/dates disagreed.
 *
 * 3. **"Current subscription" has one definition.** It was `orderBy createdAt`
 *    in `getHotelBilling` and `orderBy startDate` in the quota check — which
 *    could disagree, because `startDate` was back-dated. Now: the single row
 *    whose status is live, guaranteed unique by a partial unique index.
 *
 * 4. **Renewal exists.** Previously nothing renewed: `expireOverdueSubscriptions`
 *    only flipped status to expired, so every paying hotel died at period end
 *    until an admin re-assigned the plan by hand.
 *
 * 5. **MRR reads the snapshot, per currency.** It summed `plan.priceMonthly`
 *    across mixed-currency plans into one number the UI rendered with a hardcoded
 *    "$", and editing a plan's price silently rewrote current MRR.
 */
import { Prisma, SubscriptionStatus, InvoiceStatus } from "@prisma/client";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";
import {
  computeFirstPeriod,
  computeNextPeriod,
  proratePeriod,
  monthKey,
  DEFAULT_BILLING_TIMEZONE,
} from "../billing/period";
import { issueInvoice } from "./invoice.service";
import { recordBillingEvent } from "./audit.service";

const log = logger.child({ service: "billing" });

/** Statuses that mean "this subscription is the hotel's live agreement". */
export const LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
];

/** Statuses under which the hotel is still entitled to service. */
export const SERVING_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
];

// ── Platform billing config (Redis read-through, mirrors getPlatformMaxStayCeiling)

const BILLING_CONFIG_KEY = "billing:platform-config";
const BILLING_CONFIG_TTL = 300; // 5 min

export type BillingConfig = { timezone: string; gracePeriodDays: number };

const FALLBACK_CONFIG: BillingConfig = { timezone: DEFAULT_BILLING_TIMEZONE, gracePeriodDays: 7 };

/**
 * The platform's billing timezone + grace period. Never throws — the billing
 * cron and every quota check depend on this, so a Redis or DB blip falls back to
 * the in-code defaults rather than failing the caller.
 */
export async function getBillingConfig(): Promise<BillingConfig> {
  try {
    const raw = await redis.get(BILLING_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as BillingConfig;
      if (parsed?.timezone) return parsed;
    }
  } catch (err) {
    log.warn({ err }, "billing config cache GET failed — falling back to Postgres");
  }

  let config = FALLBACK_CONFIG;
  try {
    const row = await prisma.platformSettings.findUnique({
      where: { id: "global" },
      select: { billingTimezone: true, gracePeriodDays: true },
    });
    if (row) {
      config = {
        timezone: row.billingTimezone || DEFAULT_BILLING_TIMEZONE,
        gracePeriodDays: Number.isFinite(row.gracePeriodDays) ? Math.max(0, row.gracePeriodDays) : 7,
      };
    }
  } catch (err) {
    log.warn({ err }, "billing config DB read failed — using in-code defaults");
    return FALLBACK_CONFIG;
  }

  redis
    .set(BILLING_CONFIG_KEY, JSON.stringify(config), "EX", BILLING_CONFIG_TTL)
    .catch((err) => log.warn({ err }, "billing config cache SET failed"));
  return config;
}

/** Call after any PlatformSettings write that touches billing fields. */
export function invalidateBillingConfigCache(): void {
  redis.del(BILLING_CONFIG_KEY).catch((err) => log.warn({ err }, "billing config cache DEL failed"));
}

// ── Subscription status cache (read on EVERY authenticated request) ──────────

const statusKey = (hotelId: string) => `billing:status:${hotelId}`;
const STATUS_TTL = 300; // 5 min

/**
 * A hotel's subscription status, cached.
 *
 * `auth.middleware` previously hit Postgres on **every single authenticated
 * request** (a user+hotel join) purely to read this one enum. Same read-through
 * shape as `getPlatformMaxStayCeiling`; never throws.
 *
 * Returns null only when the hotel genuinely does not exist.
 */
export async function getSubscriptionStatus(hotelId: string): Promise<SubscriptionStatus | null> {
  try {
    const cached = await redis.get(statusKey(hotelId));
    if (cached && cached in SubscriptionStatus) return cached as SubscriptionStatus;
  } catch (err) {
    log.warn({ err, hotelId }, "subscription status cache GET failed");
  }

  let status: SubscriptionStatus | null = null;
  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id: hotelId },
      select: { subscriptionStatus: true },
    });
    status = hotel?.subscriptionStatus ?? null;
  } catch (err) {
    // Fail OPEN: a DB blip must not lock every tenant out of the dashboard.
    log.error({ err, hotelId }, "subscription status DB read failed — treating as ACTIVE");
    return SubscriptionStatus.ACTIVE;
  }

  if (status) {
    redis
      .set(statusKey(hotelId), status, "EX", STATUS_TTL)
      .catch((err) => log.warn({ err, hotelId }, "subscription status cache SET failed"));
  }
  return status;
}

/** Call after ANY write that changes Hotel.subscriptionStatus. */
export function invalidateSubscriptionStatusCache(hotelId: string): void {
  redis.del(statusKey(hotelId)).catch((err) => log.warn({ err, hotelId }, "status cache DEL failed"));
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * THE definition of a hotel's current subscription — the one row in a live
 * status. The partial unique index `Subscription_one_live_per_hotel` guarantees
 * there is at most one, so this can never disagree with itself the way the old
 * `createdAt`-vs-`startDate` orderings did.
 */
export async function getCurrentSubscription(hotelId: string) {
  return prisma.subscription.findFirst({
    where: { hotelId, status: { in: LIVE_STATUSES } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getHotelBilling(hotelId: string) {
  const hotel = await prisma.hotel.findUnique({
    where: { id: hotelId },
    include: { plan: true },
  });
  if (!hotel) throw new Error("Hotel not found");

  const subscription = await getCurrentSubscription(hotelId);
  return { hotel, subscription };
}

// ── Internal: close out whatever the hotel currently has ─────────────────────

/**
 * Mark every live subscription for a hotel CANCELED, inside `tx`.
 *
 * Required before creating a new one: the partial unique index would otherwise
 * reject the insert. That rejection is the point — it is what makes "one live
 * subscription per hotel" a database guarantee rather than a convention.
 */
async function cancelLiveSubscriptions(tx: Prisma.TransactionClient, hotelId: string, now: Date) {
  await tx.subscription.updateMany({
    where: { hotelId, status: { in: LIVE_STATUSES } },
    data: { status: SubscriptionStatus.CANCELED, canceledAt: now },
  });
}

// ── Plan assignment ──────────────────────────────────────────────────────────

export type AssignPlanOptions = {
  /** VakettaAdmin.id, for the audit trail. */
  actorId?: string | null;
  /** Issue the prorated first invoice immediately. Default true. */
  issueFirstInvoice?: boolean;
};

/**
 * Put a hotel on a paid plan.
 *
 * The subscription snapshots the plan's terms so a later price edit never
 * retroactively changes what this hotel is billed for the current period, and
 * the first (partial) period is invoiced pro rata.
 */
export async function assignPlanToHotel(hotelId: string, planId: string, opts: AssignPlanOptions = {}) {
  const { timezone } = await getBillingConfig();
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } });
    const hotel = await tx.hotel.findUnique({ where: { id: hotelId }, select: { id: true } });
    if (!hotel) throw new Error("Hotel not found");

    await cancelLiveSubscriptions(tx, hotelId, now);

    const { periodStart, periodEnd } = computeFirstPeriod(now, timezone);

    const subscription = await tx.subscription.create({
      data: {
        hotelId,
        planId,
        status: SubscriptionStatus.ACTIVE,
        planName: plan.name,
        currency: plan.currency,
        price: plan.priceMonthly,
        conversationLimit: plan.conversationLimit,
        aiReplyLimit: plan.aiReplyLimit,
        extraConversationCharge: plan.extraConversationCharge,
        extraAiReplyCharge: plan.extraAiReplyCharge,
        startDate: periodStart,
        endDate: periodEnd,
        autoRenew: true,
      },
    });

    await tx.hotel.update({
      where: { id: hotelId },
      data: {
        planId,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        billingStartDate: periodStart,
        billingEndDate: periodEnd,
      },
    });

    return { subscription, plan, periodStart, periodEnd };
  });

  invalidateSubscriptionStatusCache(hotelId);

  // Prorated first charge — the fix for "signed up on the 28th, billed a full month".
  const proratedAmount = proratePeriod(result.plan.priceMonthly, {
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
  }, timezone);

  if (opts.issueFirstInvoice !== false && proratedAmount > 0) {
    try {
      await issueInvoice({
        hotelId,
        subscriptionId: result.subscription.id,
        currency: result.plan.currency,
        subscriptionAmount: proratedAmount,
        // No usage has accrued in a period that just began.
        usage: { conversationsUsed: 0, aiRepliesUsed: 0 },
        terms: result.subscription,
        periodStart: result.periodStart,
        periodEnd: result.periodEnd,
        prorated: proratedAmount < result.plan.priceMonthly,
      });
    } catch (err) {
      // The subscription is live and correct; a failed invoice is recoverable
      // by the renewal cron and must not roll back the assignment.
      log.error({ err, hotelId }, "failed to issue first invoice — subscription is still active");
    }
  }

  await recordBillingEvent("plan.assigned", {
    hotelId,
    actorId: opts.actorId ?? null,
    data: {
      planId,
      planName: result.plan.name,
      price: result.plan.priceMonthly,
      currency: result.plan.currency,
      proratedAmount,
      periodStart: result.periodStart.toISOString(),
      periodEnd: result.periodEnd.toISOString(),
    },
  });

  const { emitToAdmin } = await import("../realtime/emit");
  emitToAdmin("admin:subscription_changed", {
    hotelId,
    planId,
    status: SubscriptionStatus.ACTIVE,
    billingEndDate: result.periodEnd,
  });

  return result.subscription;
}

// ── Trials ───────────────────────────────────────────────────────────────────

export type TrialOverrides = {
  durationDays?: number;
  conversationLimit?: number;
  aiReplyLimit?: number;
};

/**
 * Start a free trial, transactionally.
 *
 * `tx` is accepted so hotel creation can start the trial in the SAME transaction
 * that creates the hotel — otherwise a crash between the two leaves a hotel with
 * `TRIALING` status, a null `billingEndDate` and no subscription, which is
 * exactly the "free forever" state this fixes.
 */
export async function startTrial(hotelId: string, overrides?: TrialOverrides, tx?: Prisma.TransactionClient) {
  const now = new Date();

  const run = async (db: Prisma.TransactionClient) => {
    const config = await db.trialConfig.upsert({
      where: { id: "global" },
      update: {},
      create: { id: "global" },
    });

    const days = overrides?.durationDays ?? config.durationDays;
    const convLim = overrides?.conversationLimit ?? config.conversationLimit;
    const aiLim = overrides?.aiReplyLimit ?? config.aiReplyLimit;
    const endDate = new Date(now.getTime() + days * 86_400_000);

    await cancelLiveSubscriptions(db, hotelId, now);

    const subscription = await db.subscription.create({
      data: {
        hotelId,
        planId: null,
        status: SubscriptionStatus.TRIALING,
        planName: "Trial",
        // Trials are free, so the currency is cosmetic — but hardcoding "USD"
        // made the hotel page render a ₹-priced product in dollars.
        currency: config.currency ?? "INR",
        price: 0,
        conversationLimit: convLim,
        aiReplyLimit: aiLim,
        extraConversationCharge: 0,
        extraAiReplyCharge: 0,
        startDate: now,
        endDate,
        // A trial must never silently roll into a paid period.
        autoRenew: false,
      },
    });

    await db.hotel.update({
      where: { id: hotelId },
      data: {
        planId: null,
        subscriptionStatus: SubscriptionStatus.TRIALING,
        billingStartDate: now,
        billingEndDate: endDate,
      },
    });

    return { subscription, days, convLim, aiLim, endDate };
  };

  const result = tx ? await run(tx) : await prisma.$transaction(run);

  invalidateSubscriptionStatusCache(hotelId);

  await recordBillingEvent(
    "trial.started",
    {
      hotelId,
      data: {
        durationDays: result.days,
        conversationLimit: result.convLim,
        aiReplyLimit: result.aiLim,
        endDate: result.endDate.toISOString(),
      },
    },
    tx,
  );

  // Deferred when inside a caller's transaction: emitting before commit would
  // announce a subscription that might still roll back.
  if (!tx) {
    const { emitToAdmin } = await import("../realtime/emit");
    emitToAdmin("admin:subscription_changed", {
      hotelId,
      planId: null,
      status: SubscriptionStatus.TRIALING,
      billingEndDate: result.endDate,
    });
  }

  return {
    subscriptionStatus: SubscriptionStatus.TRIALING,
    billingStartDate: now,
    billingEndDate: result.endDate,
    conversationLimit: result.convLim,
    aiReplyLimit: result.aiLim,
    durationDays: result.days,
  };
}

// ── Cancel / extend (admin controls that did not exist) ──────────────────────

/**
 * Cancel a hotel's subscription. `immediate` suspends now; otherwise service
 * continues to the end of the paid period and simply does not renew.
 */
export async function cancelSubscription(hotelId: string, immediate = false, actorId?: string | null) {
  const now = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.subscription.findFirst({
      where: { hotelId, status: { in: LIVE_STATUSES } },
    });
    if (!current) throw new Error("Hotel has no active subscription");

    const sub = await tx.subscription.update({
      where: { id: current.id },
      data: immediate
        ? { status: SubscriptionStatus.CANCELED, canceledAt: now, autoRenew: false, endDate: now }
        : { autoRenew: false, canceledAt: now },
    });

    if (immediate) {
      await tx.hotel.update({
        where: { id: hotelId },
        data: { subscriptionStatus: SubscriptionStatus.EXPIRED, billingEndDate: now },
      });
    }

    return sub;
  });

  invalidateSubscriptionStatusCache(hotelId);

  await recordBillingEvent("subscription.canceled", {
    hotelId,
    actorId: actorId ?? null,
    data: { immediate, subscriptionId: updated.id, endsAt: updated.endDate?.toISOString() ?? null },
  });

  const { emitToAdmin } = await import("../realtime/emit");
  emitToAdmin("admin:subscription_changed", {
    hotelId,
    planId: updated.planId,
    status: immediate ? SubscriptionStatus.EXPIRED : SubscriptionStatus.ACTIVE,
    billingEndDate: updated.endDate,
  });

  return updated;
}

/** Push a hotel's current period end out by `days` — a goodwill/manual override. */
export async function extendSubscription(hotelId: string, days: number, actorId?: string | null) {
  const extendBy = Math.round(days);
  if (!Number.isFinite(extendBy) || extendBy === 0) throw new Error("days must be a non-zero whole number");

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.subscription.findFirst({
      where: { hotelId, status: { in: LIVE_STATUSES } },
    });
    if (!current) throw new Error("Hotel has no active subscription");

    const base = current.endDate ?? new Date();
    const newEnd = new Date(base.getTime() + extendBy * 86_400_000);

    const sub = await tx.subscription.update({
      where: { id: current.id },
      data: { endDate: newEnd },
    });

    await tx.hotel.update({
      where: { id: hotelId },
      data: {
        billingEndDate: newEnd,
        // An extension on a suspended hotel is meant to restore service.
        ...(newEnd > new Date() ? { subscriptionStatus: current.status } : {}),
      },
    });

    return sub;
  });

  invalidateSubscriptionStatusCache(hotelId);

  await recordBillingEvent("subscription.renewed", {
    hotelId,
    actorId: actorId ?? null,
    data: { manualExtension: true, days: extendBy, endDate: updated.endDate?.toISOString() ?? null },
  });

  return updated;
}

// ── Renewal ──────────────────────────────────────────────────────────────────

/**
 * Roll every due subscription into its next period, issuing an invoice for the
 * period just closed.
 *
 * Idempotent on two levels: the `endDate <= now` filter stops matching once the
 * period rolls, and `Invoice.@@unique([hotelId, periodStart])` means even a
 * concurrent tick converges on one invoice.
 *
 * Trials are excluded — `autoRenew: false` on every trial subscription, so a
 * free trial can never silently become a paid period.
 */
export async function renewDueSubscriptions(now: Date = new Date()): Promise<number> {
  const { timezone } = await getBillingConfig();

  const due = await prisma.subscription.findMany({
    where: {
      status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
      autoRenew: true,
      endDate: { lte: now, not: null },
    },
    select: {
      id: true,
      hotelId: true,
      planId: true,
      currency: true,
      price: true,
      conversationLimit: true,
      aiReplyLimit: true,
      extraConversationCharge: true,
      extraAiReplyCharge: true,
      startDate: true,
      endDate: true,
    },
  });

  let renewed = 0;

  for (const sub of due) {
    const closingStart = sub.startDate;
    const closingEnd = sub.endDate!;
    const next = computeNextPeriod(closingEnd, timezone);

    try {
      // Usage for the month the closing period belongs to. Billing periods are
      // calendar-aligned precisely so this key lines up exactly.
      const usage = await prisma.usageRecord.findUnique({
        where: { hotelId_month: { hotelId: sub.hotelId, month: monthKey(closingStart, timezone) } },
        select: { conversationsUsed: true, aiRepliesUsed: true },
      });

      await prisma.$transaction(async (tx) => {
        await issueInvoice(
          {
            hotelId: sub.hotelId,
            subscriptionId: sub.id,
            currency: sub.currency,
            subscriptionAmount: sub.price,
            usage: usage ?? { conversationsUsed: 0, aiRepliesUsed: 0 },
            terms: sub,
            periodStart: closingStart,
            periodEnd: closingEnd,
          },
          tx,
        );

        await tx.subscription.update({
          where: { id: sub.id },
          data: { startDate: next.periodStart, endDate: next.periodEnd },
        });

        await tx.hotel.update({
          where: { id: sub.hotelId },
          data: { billingStartDate: next.periodStart, billingEndDate: next.periodEnd },
        });
      });

      invalidateSubscriptionStatusCache(sub.hotelId);
      renewed++;

      await recordBillingEvent("subscription.renewed", {
        hotelId: sub.hotelId,
        actorType: "SYSTEM",
        data: {
          subscriptionId: sub.id,
          closedPeriodStart: closingStart.toISOString(),
          newPeriodEnd: next.periodEnd.toISOString(),
        },
      });

      const { emitToAdmin } = await import("../realtime/emit");
      emitToAdmin("admin:subscription_changed", {
        hotelId: sub.hotelId,
        planId: sub.planId,
        status: SubscriptionStatus.ACTIVE,
        billingEndDate: next.periodEnd,
      });
    } catch (err) {
      // One hotel's bad row must not stop the rest of the batch renewing.
      log.error({ err, hotelId: sub.hotelId, subscriptionId: sub.id }, "renewal failed for hotel");
    }
  }

  return renewed;
}

// ── Suspension ───────────────────────────────────────────────────────────────

/**
 * Suspend hotels whose paid period or trial has lapsed.
 *
 * Unlike the old `expireOverdueSubscriptions`, this also closes the subscription
 * row (which used to be left dangling as if still live), emits the socket event
 * the admin panel needs, and writes an audit record.
 *
 * NULL `billingEndDate` is still deliberately not matched: those are the legacy
 * "free forever" hotels, and suspending live tenants from a cron with no warning
 * is not a decision a background job gets to make. See scripts/billingBackfillReport.ts.
 */
export async function expireOverdueSubscriptions(now: Date = new Date()): Promise<number> {
  const lapsed = await prisma.hotel.findMany({
    where: {
      subscriptionStatus: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING, SubscriptionStatus.PAST_DUE] },
      billingEndDate: { lt: now, not: null },
    },
    select: { id: true, planId: true, subscriptionStatus: true, billingEndDate: true },
  });

  let expired = 0;

  for (const hotel of lapsed) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.hotel.update({
          where: { id: hotel.id },
          data: { subscriptionStatus: SubscriptionStatus.EXPIRED },
        });
        await tx.subscription.updateMany({
          where: { hotelId: hotel.id, status: { in: LIVE_STATUSES } },
          data: { status: SubscriptionStatus.EXPIRED },
        });
      });

      invalidateSubscriptionStatusCache(hotel.id);
      expired++;

      await recordBillingEvent("subscription.expired", {
        hotelId: hotel.id,
        actorType: "SYSTEM",
        data: {
          previousStatus: hotel.subscriptionStatus,
          billingEndDate: hotel.billingEndDate?.toISOString() ?? null,
        },
      });

      const { emitToAdmin } = await import("../realtime/emit");
      emitToAdmin("admin:subscription_changed", {
        hotelId: hotel.id,
        planId: hotel.planId,
        status: SubscriptionStatus.EXPIRED,
        billingEndDate: hotel.billingEndDate,
      });
    } catch (err) {
      log.error({ err, hotelId: hotel.id }, "failed to expire hotel");
    }
  }

  return expired;
}

/** Move a hotel to PAST_DUE — service continues through the grace window. */
export async function markPastDue(hotelId: string): Promise<boolean> {
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const res = await tx.hotel.updateMany({
        where: { id: hotelId, subscriptionStatus: SubscriptionStatus.ACTIVE },
        data: { subscriptionStatus: SubscriptionStatus.PAST_DUE },
      });
      if (res.count === 0) return false;

      await tx.subscription.updateMany({
        where: { hotelId, status: SubscriptionStatus.ACTIVE },
        data: { status: SubscriptionStatus.PAST_DUE },
      });
      return true;
    });

    if (!updated) return false;

    invalidateSubscriptionStatusCache(hotelId);
    await recordBillingEvent("subscription.past_due", { hotelId, actorType: "SYSTEM" });

    const { emitToAdmin } = await import("../realtime/emit");
    emitToAdmin("admin:subscription_changed", {
      hotelId,
      planId: null,
      status: SubscriptionStatus.PAST_DUE,
      billingEndDate: null,
    });
    return true;
  } catch (err) {
    log.error({ err, hotelId }, "failed to mark hotel past due");
    return false;
  }
}

// ── Admin analytics ──────────────────────────────────────────────────────────

export type CurrencyTotals = Record<string, number>;

/**
 * Platform billing analytics.
 *
 * MRR is **per currency** and read from the subscription SNAPSHOT. The old
 * version summed `plan.priceMonthly` across INR/USD/AED plans into a single
 * number the UI rendered with a hardcoded "$", and because it read the live plan
 * rather than the snapshot, editing a plan's price rewrote current MRR.
 *
 * `mrrHistory` comes from issued invoices — the honest figure for a month. The
 * old series grouped subscriptions by `startDate` month, which actually measured
 * "value of subscriptions STARTED in month X", not recurring revenue: a hotel
 * that had not changed plan in three months contributed zero to those months.
 */
export async function getAdminBillingAnalytics() {
  const [byCurrency, invoiceHistory, activeCount] = await Promise.all([
    prisma.subscription.groupBy({
      by: ["currency"],
      where: { status: SubscriptionStatus.ACTIVE, price: { gt: 0 } },
      _sum: { price: true },
      _count: { _all: true },
    }),
    prisma.invoice.findMany({
      where: { status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PAID] } },
      orderBy: { periodStart: "asc" },
      select: { currency: true, total: true, periodStart: true },
    }),
    prisma.hotel.count({ where: { subscriptionStatus: SubscriptionStatus.ACTIVE } }),
  ]);

  const mrr: CurrencyTotals = {};
  const paidHotels: CurrencyTotals = {};
  for (const row of byCurrency) {
    mrr[row.currency] = row._sum.price ?? 0;
    paidHotels[row.currency] = row._count._all;
  }

  const { timezone } = await getBillingConfig();

  // month → currency → total
  const byMonth = new Map<string, CurrencyTotals>();
  for (const inv of invoiceHistory) {
    const m = monthKey(inv.periodStart, timezone);
    const bucket = byMonth.get(m) ?? {};
    bucket[inv.currency] = (bucket[inv.currency] ?? 0) + inv.total;
    byMonth.set(m, bucket);
  }

  const mrrHistory = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([month, totals]) => ({ month, totals }));

  const currencies = [...new Set([...Object.keys(mrr), ...mrrHistory.flatMap((r) => Object.keys(r.totals))])].sort();

  return { mrr, paidHotels, mrrHistory, currencies, activeHotelsCount: activeCount };
}
