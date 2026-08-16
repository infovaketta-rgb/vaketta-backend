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
 *
 * 6. **Periods are ANCHORED, and entitlement is derived from the clock.**
 *    Periods used to be whole calendar months after the first, so a
 *    subscription starting on the 15th was shown as "15 Aug → 01 Sep" and then
 *    billed 1st-to-1st forever. They now recur on the subscription's own
 *    billing day (billing/period.ts). Separately, `Hotel.subscriptionStatus`
 *    is no longer the authority on access: `billing/effectiveStatus.ts` derives
 *    the live state from `now`, and this service's cron functions only
 *    MATERIALISE that state (persist the roll, issue invoices, notify).
 *
 * 7. **Trials convert instead of expiring.** `scheduledPlanId` on a trial row
 *    makes the paid period begin at exactly the trial's exclusive end, so there
 *    is no instant at which the customer is neither trialing nor paid.
 */
import { Prisma, SubscriptionStatus, InvoiceStatus } from "@prisma/client";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";
import {
  anchorDayOf,
  addDaysInTZ,
  computeAnchoredPeriod,
  nextAnchoredPeriod,
  startOfDayInTZ,
  monthKey,
  DEFAULT_BILLING_TIMEZONE,
  type Period,
} from "../billing/period";
import {
  resolveEffectiveState,
  boundedCacheTtlSeconds,
  paidPeriodAfterTrial,
  type EffectiveState,
  type SubscriptionState,
} from "../billing/effectiveStatus";
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

// ── Effective subscription state (read on EVERY authenticated request) ───────

const statusKey = (hotelId: string) => `billing:sub:${hotelId}`;
const STATUS_TTL = 300; // 5 min ceiling — clamped down near a boundary

/**
 * The billed terms a meter is measured against.
 *
 * Carried on the effective state so ENTITLEMENT AND LIMITS COME FROM ONE READ.
 * They used to come from different places: limits from the live subscription
 * row, usage from the effective period. In the window between a trial's
 * boundary and the cron materialising the conversion, that meant the trial's
 * limits were applied to the fresh paid period's usage.
 */
export type BilledTerms = {
  planName: string;
  currency: string;
  price: number;
  conversationLimit: number;
  aiReplyLimit: number;
  extraConversationCharge: number;
  extraAiReplyCharge: number;
};

/** What we cache: the subscription's raw fields, never a derived verdict. */
type CachedSubscription = {
  status: SubscriptionStatus;
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  billingAnchorDay: number | null;
  scheduledPlanId: string | null;
  /** The row's own snapshot terms. Null when there is no subscription row. */
  terms: BilledTerms | null;
  /**
   * Terms of the plan queued at a trial's boundary. Read from the live Plan —
   * which is exactly what `convertScheduledTrial` will snapshot moments later,
   * so the pre- and post-materialisation answers agree.
   */
  scheduledTerms?: BilledTerms | null;
};

export type EffectiveSubscription = EffectiveState & {
  hotelId: string;
  /**
   * The terms in force at `now`. After a trial converts these are the SCHEDULED
   * plan's, not the trial's. Null for a hotel with no subscription row — the
   * legacy "free forever" state, which is metered as unlimited.
   */
  terms: BilledTerms | null;
};

const termsOf = (row: {
  planName: string;
  currency: string;
  price: number;
  conversationLimit: number;
  aiReplyLimit: number;
  extraConversationCharge: number;
  extraAiReplyCharge: number;
}): BilledTerms => ({
  planName: row.planName,
  currency: row.currency,
  price: row.price,
  conversationLimit: row.conversationLimit,
  aiReplyLimit: row.aiReplyLimit,
  extraConversationCharge: row.extraConversationCharge,
  extraAiReplyCharge: row.extraAiReplyCharge,
});

function toState(row: CachedSubscription): SubscriptionState {
  return {
    status: row.status,
    startDate: new Date(row.startDate),
    endDate: row.endDate ? new Date(row.endDate) : null,
    autoRenew: row.autoRenew,
    billingAnchorDay: row.billingAnchorDay,
    scheduledPlanId: row.scheduledPlanId,
  };
}

/**
 * Read the hotel's subscription row (or, failing that, its denormalised status)
 * in the shape the resolver consumes. Null when the hotel does not exist.
 */
async function loadSubscriptionRow(hotelId: string): Promise<CachedSubscription | null> {
  const sub = await prisma.subscription.findFirst({
    where: { hotelId, status: { in: LIVE_STATUSES } },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      startDate: true,
      endDate: true,
      autoRenew: true,
      billingAnchorDay: true,
      scheduledPlanId: true,
      planName: true,
      currency: true,
      price: true,
      conversationLimit: true,
      aiReplyLimit: true,
      extraConversationCharge: true,
      extraAiReplyCharge: true,
    },
  });

  if (sub) {
    // Only a trialing hotel can have one, so this costs nothing in the common case.
    let scheduledTerms: BilledTerms | null = null;
    if (sub.scheduledPlanId) {
      const plan = await prisma.plan.findUnique({ where: { id: sub.scheduledPlanId } });
      if (plan) scheduledTerms = termsOf({ ...plan, planName: plan.name, price: plan.priceMonthly });
    }

    return {
      status: sub.status,
      startDate: sub.startDate.toISOString(),
      endDate: sub.endDate?.toISOString() ?? null,
      autoRenew: sub.autoRenew,
      billingAnchorDay: sub.billingAnchorDay ?? null,
      scheduledPlanId: sub.scheduledPlanId ?? null,
      terms: termsOf(sub),
      scheduledTerms,
    };
  }

  // No live subscription row: legacy "free forever" tenants, and hotels whose
  // subscription was closed. Fall back to the hotel's own status with no time
  // logic — inventing a period for a row that never existed would be worse.
  const hotel = await prisma.hotel.findUnique({
    where: { id: hotelId },
    select: { subscriptionStatus: true, billingStartDate: true, billingEndDate: true },
  });
  if (!hotel) return null;

  return {
    status: hotel.subscriptionStatus,
    startDate: (hotel.billingStartDate ?? new Date(0)).toISOString(),
    endDate: null, // treated as open-ended by the resolver
    autoRenew: false,
    billingAnchorDay: null,
    scheduledPlanId: null,
    // No terms = no meter. Metering a tenant who was never given a subscription
    // would cut off live customers with no warning.
    terms: null,
  };
}

/**
 * The hotel's entitlement RIGHT NOW.
 *
 * The cached value is the subscription's raw fields; the verdict is recomputed
 * against a live `now` on every call, so a warm cache can never serve a stale
 * status across a trial or period boundary. The TTL is additionally clamped to
 * the next boundary (`boundedCacheTtlSeconds`) as defence in depth.
 *
 * Never throws. Returns null only when the hotel genuinely does not exist.
 */
export async function getEffectiveSubscription(
  hotelId: string,
  now: Date = new Date(),
): Promise<EffectiveSubscription | null> {
  const { timezone } = await getBillingConfig();

  let row: CachedSubscription | null = null;
  let fromCache = false;

  try {
    const cached = await redis.get(statusKey(hotelId));
    if (cached) {
      row = JSON.parse(cached) as CachedSubscription;
      fromCache = true;
    }
  } catch (err) {
    log.warn({ err, hotelId }, "subscription cache GET failed — falling back to Postgres");
  }

  if (!row) {
    try {
      row = await loadSubscriptionRow(hotelId);
    } catch (err) {
      // Fail OPEN: a DB blip must not lock every tenant out of the dashboard.
      log.error({ err, hotelId }, "subscription DB read failed — treating as ACTIVE");
      return {
        hotelId,
        status: SubscriptionStatus.ACTIVE,
        suspended: false,
        pastDue: false,
        periodStart: now,
        periodEnd: null,
        anchorDay: anchorDayOf(now, timezone),
        needsMaterialization: false,
        trialConverted: false,
        nextBoundary: null,
        reason: "open_ended",
        // Unmetered rather than metered against limits we could not read.
        terms: null,
      };
    }
  }

  if (!row) return null;

  const state = resolveEffectiveState(toState(row), now, timezone);

  if (!fromCache) {
    const ttl = boundedCacheTtlSeconds(state, now, STATUS_TTL);
    redis
      .set(statusKey(hotelId), JSON.stringify(row), "EX", ttl)
      .catch((err) => log.warn({ err, hotelId }, "subscription cache SET failed"));
  }

  // Once a trial has converted, the SCHEDULED plan's terms are the ones in
  // force — the trial's limits stopped applying at the boundary, not whenever
  // the cron next runs. Falls back to the row's own terms if the plan has since
  // been deleted, which is the conservative direction.
  const terms = state.trialConverted ? (row.scheduledTerms ?? row.terms) : row.terms;

  return { ...state, hotelId, terms: terms ?? null };
}

/**
 * A hotel's effective subscription status.
 *
 * Kept as the narrow entry point every existing caller already uses
 * (auth.middleware, usage.service). It is now COMPUTED, not read from a column
 * a cron job maintains — see billing/effectiveStatus.ts.
 */
export async function getSubscriptionStatus(hotelId: string): Promise<SubscriptionStatus | null> {
  const effective = await getEffectiveSubscription(hotelId);
  return effective ? (effective.status as SubscriptionStatus) : null;
}

/** Call after ANY write that changes a hotel's subscription. */
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
  /** Issue the first invoice immediately. Default true. */
  issueFirstInvoice?: boolean;
  /**
   * When the paid period begins.
   *   "trial_end" — schedule it for the trial's exclusive end (gapless).
   *   "now"       — start today, ending the trial early.
   * Omitted = "trial_end" while trialing, "now" otherwise. The default never
   * shortens a trial the customer was promised.
   */
  startAt?: "now" | "trial_end";
};

/**
 * Put a hotel on a paid plan.
 *
 * The subscription snapshots the plan's terms so a later price edit never
 * retroactively changes what this hotel is billed for the current period.
 *
 * The period is ANCHORED to the day it starts and runs a whole anchored month,
 * so there is nothing to prorate — the old model's partial first period (signup
 * → 1st of next month) is gone, and with it the "15 Aug → 01 Sep" display.
 */
export async function assignPlanToHotel(hotelId: string, planId: string, opts: AssignPlanOptions = {}) {
  const { timezone } = await getBillingConfig();
  const now = new Date();

  // Default to converting at the trial boundary rather than truncating a trial.
  if (opts.startAt !== "now") {
    const current = await getCurrentSubscription(hotelId);
    const trialing =
      current?.status === SubscriptionStatus.TRIALING &&
      current.endDate != null &&
      current.endDate.getTime() > now.getTime();

    if (trialing) {
      return schedulePlanAtTrialEnd(hotelId, planId, opts.actorId ?? null);
    }
    if (opts.startAt === "trial_end") {
      // Asked to defer, but there is no live trial to defer to.
      throw new Error("Hotel is not on a trial");
    }
  }

  // Boundaries are clean local midnights, so every downstream day-count
  // (reminders, proration, display) is stable regardless of what time of day an
  // admin happened to click the button.
  const periodStart = startOfDayInTZ(now, timezone);
  const anchorDay = anchorDayOf(periodStart, timezone);
  const { periodEnd } = computeAnchoredPeriod(periodStart, anchorDay, timezone);

  const result = await prisma.$transaction(async (tx) => {
    const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } });
    const hotel = await tx.hotel.findUnique({ where: { id: hotelId }, select: { id: true } });
    if (!hotel) throw new Error("Hotel not found");

    await cancelLiveSubscriptions(tx, hotelId, now);

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
        billingAnchorDay: anchorDay,
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

    return { subscription, plan };
  });

  invalidateSubscriptionStatusCache(hotelId);

  // A full anchored month of service — charged in full. `Invoice`'s
  // @@unique([hotelId, periodStart]) keeps this idempotent against the renewal
  // cron, which will find this invoice already present when the period closes.
  if (opts.issueFirstInvoice !== false && result.plan.priceMonthly > 0) {
    try {
      await issueInvoice({
        hotelId,
        subscriptionId: result.subscription.id,
        currency: result.plan.currency,
        subscriptionAmount: result.plan.priceMonthly,
        // No usage has accrued in a period that just began.
        usage: { conversationsUsed: 0, aiRepliesUsed: 0 },
        terms: result.subscription,
        periodStart,
        periodEnd,
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
      billingAnchorDay: anchorDay,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    },
  });

  const { emitToAdmin } = await import("../realtime/emit");
  emitToAdmin("admin:subscription_changed", {
    hotelId,
    planId,
    status: SubscriptionStatus.ACTIVE,
    billingEndDate: periodEnd,
  });

  return result.subscription;
}

/**
 * Schedule a paid plan to begin at EXACTLY the trial's exclusive end.
 *
 * Nothing about the trial changes — same end instant, same limits — so the
 * customer keeps every day they were promised. At `trialEnd` the resolver
 * already reports ACTIVE (see billing/effectiveStatus.ts); the cron merely
 * materialises the paid Subscription row afterwards. That ordering is the whole
 * point: access does not wait for a background job.
 */
export async function schedulePlanAtTrialEnd(hotelId: string, planId: string, actorId?: string | null) {
  const { timezone } = await getBillingConfig();
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } });

    const trial = await tx.subscription.findFirst({
      where: { hotelId, status: SubscriptionStatus.TRIALING },
      orderBy: { createdAt: "desc" },
    });
    if (!trial || !trial.endDate) throw new Error("Hotel is not on a trial");

    const subscription = await tx.subscription.update({
      where: { id: trial.id },
      data: { scheduledPlanId: planId },
    });

    return { subscription, plan, trialEnd: trial.endDate };
  });

  invalidateSubscriptionStatusCache(hotelId);

  const { period, anchorDay } = paidPeriodAfterTrial(result.trialEnd, timezone);

  await recordBillingEvent("plan.scheduled", {
    hotelId,
    actorId: actorId ?? null,
    data: {
      planId,
      planName: result.plan.name,
      price: result.plan.priceMonthly,
      currency: result.plan.currency,
      billingAnchorDay: anchorDay,
      startsAt: period.periodStart.toISOString(),
      periodEnd: period.periodEnd.toISOString(),
    },
  });

  const { emitToAdmin } = await import("../realtime/emit");
  emitToAdmin("admin:subscription_changed", {
    hotelId,
    planId,
    status: SubscriptionStatus.TRIALING,
    billingEndDate: result.trialEnd,
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
  const { timezone } = await getBillingConfig();
  const now = new Date();

  // Clean local-midnight boundaries, both ends. `now + days * 86_400_000` gave
  // a trial that ended at whatever time of day it started — which made the
  // reminder-day arithmetic and the paid anchor depend on a button-click
  // timestamp, and drifted by an hour across a DST transition.
  //
  // Half-open: a 14-day trial started on 15 Aug ends at 29 Aug 00:00, i.e.
  // 15 Aug 00:00 <= t < 29 Aug 00:00 is TRIAL, and 29 Aug 00:00 is already paid.
  const startDate = startOfDayInTZ(now, timezone);

  const run = async (db: Prisma.TransactionClient) => {
    const config = await db.trialConfig.upsert({
      where: { id: "global" },
      update: {},
      create: { id: "global" },
    });

    const days = overrides?.durationDays ?? config.durationDays;
    const convLim = overrides?.conversationLimit ?? config.conversationLimit;
    const aiLim = overrides?.aiReplyLimit ?? config.aiReplyLimit;
    const endDate = addDaysInTZ(startDate, days, timezone);

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
        startDate,
        endDate,
        billingAnchorDay: anchorDayOf(startDate, timezone),
        // A trial never rolls into a paid period by itself. Conversion is
        // explicit and opt-in: an admin sets `scheduledPlanId`.
        autoRenew: false,
      },
    });

    await db.hotel.update({
      where: { id: hotelId },
      data: {
        planId: null,
        subscriptionStatus: SubscriptionStatus.TRIALING,
        billingStartDate: startDate,
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
    billingStartDate: startDate,
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

/**
 * Push a hotel's current period end out by `days` — a goodwill/manual override.
 *
 * The ANCHOR IS PINNED FIRST. An extension moves only this period's end; the
 * recurring billing day must not move with it. On a row that predates the anchor
 * column the anchor would otherwise be re-derived from the *extended* end, which
 * would permanently re-anchor the customer onto a one-off goodwill date. Pinning
 * it from the CURRENT end before moving anything keeps the schedule intact, and
 * `nextAnchorAfter` then realigns with a single short period rather than
 * overshooting to the following month.
 */
export async function extendSubscription(hotelId: string, days: number, actorId?: string | null) {
  const extendBy = Math.round(days);
  if (!Number.isFinite(extendBy) || extendBy === 0) throw new Error("days must be a non-zero whole number");

  const { timezone } = await getBillingConfig();

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.subscription.findFirst({
      where: { hotelId, status: { in: LIVE_STATUSES } },
    });
    if (!current) throw new Error("Hotel has no active subscription");

    const base = current.endDate ?? new Date();
    const newEnd = new Date(base.getTime() + extendBy * 86_400_000);
    const anchorDay = current.billingAnchorDay ?? anchorDayOf(base, timezone);

    const sub = await tx.subscription.update({
      where: { id: current.id },
      data: { endDate: newEnd, billingAnchorDay: anchorDay },
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

// ── Materialisation (the cron's job — NOT the source of entitlement) ─────────

/**
 * Ceiling on how many periods one subscription may roll in a single pass.
 * A subscription 3 years stale is a data problem, not a billing run.
 */
const MAX_CATCHUP_PERIODS = 36;

/**
 * Convert one trial whose scheduled plan has come into force.
 *
 * The customer has ALREADY been ACTIVE since `trialEnd` — `resolveEffectiveState`
 * said so the instant the boundary passed. This only writes it down: the paid
 * subscription starts at exactly `trialEnd`, so the trial period and the paid
 * period share one boundary and no time is unaccounted for.
 */
async function convertScheduledTrial(
  trial: { id: string; hotelId: string; endDate: Date; scheduledPlanId: string },
  timezone: string,
  now: Date,
): Promise<boolean> {
  const { period, anchorDay } = paidPeriodAfterTrial(trial.endDate, timezone);

  const result = await prisma.$transaction(async (tx) => {
    const plan = await tx.plan.findUnique({ where: { id: trial.scheduledPlanId } });
    if (!plan) throw new Error(`Scheduled plan ${trial.scheduledPlanId} no longer exists`);

    // Re-read under the transaction: another tick may have converted already.
    const live = await tx.subscription.findFirst({
      where: { id: trial.id, status: SubscriptionStatus.TRIALING },
    });
    if (!live) return null;

    await cancelLiveSubscriptions(tx, trial.hotelId, now);

    const subscription = await tx.subscription.create({
      data: {
        hotelId: trial.hotelId,
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        planName: plan.name,
        currency: plan.currency,
        price: plan.priceMonthly,
        conversationLimit: plan.conversationLimit,
        aiReplyLimit: plan.aiReplyLimit,
        extraConversationCharge: plan.extraConversationCharge,
        extraAiReplyCharge: plan.extraAiReplyCharge,
        startDate: period.periodStart,
        endDate: period.periodEnd,
        billingAnchorDay: anchorDay,
        autoRenew: true,
      },
    });

    await tx.hotel.update({
      where: { id: trial.hotelId },
      data: {
        planId: plan.id,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        billingStartDate: period.periodStart,
        billingEndDate: period.periodEnd,
      },
    });

    return { subscription, plan };
  });

  if (!result) return false;

  invalidateSubscriptionStatusCache(trial.hotelId);

  if (result.plan.priceMonthly > 0) {
    try {
      await issueInvoice({
        hotelId: trial.hotelId,
        subscriptionId: result.subscription.id,
        currency: result.plan.currency,
        subscriptionAmount: result.plan.priceMonthly,
        // Trial usage lives in the TRIAL period's usage bucket and is never
        // read here — the first paid invoice only ever sees paid-period usage.
        usage: { conversationsUsed: 0, aiRepliesUsed: 0 },
        terms: result.subscription,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      });
    } catch (err) {
      log.error({ err, hotelId: trial.hotelId }, "trial conversion invoice failed — subscription is still active");
    }
  }

  await recordBillingEvent("trial.converted", {
    hotelId: trial.hotelId,
    actorType: "SYSTEM",
    data: {
      planId: result.plan.id,
      planName: result.plan.name,
      trialEnd: trial.endDate.toISOString(),
      periodStart: period.periodStart.toISOString(),
      periodEnd: period.periodEnd.toISOString(),
      billingAnchorDay: anchorDay,
    },
  });

  const { emitToAdmin } = await import("../realtime/emit");
  emitToAdmin("admin:subscription_changed", {
    hotelId: trial.hotelId,
    planId: result.plan.id,
    status: SubscriptionStatus.ACTIVE,
    billingEndDate: period.periodEnd,
  });

  return true;
}

/** Materialise every trial whose scheduled plan is now in force. */
export async function convertDueTrials(now: Date = new Date()): Promise<number> {
  const { timezone } = await getBillingConfig();

  const due = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.TRIALING,
      endDate: { lte: now, not: null },
      scheduledPlanId: { not: null },
    },
    select: { id: true, hotelId: true, endDate: true, scheduledPlanId: true },
  });

  let converted = 0;
  for (const trial of due) {
    try {
      const ok = await convertScheduledTrial(
        { id: trial.id, hotelId: trial.hotelId, endDate: trial.endDate!, scheduledPlanId: trial.scheduledPlanId! },
        timezone,
        now,
      );
      if (ok) converted++;
    } catch (err) {
      // The customer is already ACTIVE per the resolver; a failed write is
      // retried next tick and must not stop the rest of the batch.
      log.error({ err, hotelId: trial.hotelId, subscriptionId: trial.id }, "trial conversion failed");
    }
  }

  return converted;
}

/**
 * Roll every due subscription into its next period, issuing an invoice for each
 * period closed along the way.
 *
 * This no longer decides whether the customer has access — `getEffectiveSubscription`
 * already reported the rolled period from the clock alone. What this adds is the
 * durable record: the persisted period and the invoice.
 *
 * Idempotent on three levels: the `endDate <= now` filter stops matching once
 * the period rolls, `Invoice.@@unique([hotelId, periodStart])` means even a
 * concurrent tick converges on one invoice, and each period rolls in its own
 * transaction so a mid-catch-up failure resumes cleanly on the next tick.
 *
 * Trials are excluded (`autoRenew: false`); conversion is `convertDueTrials`.
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
      billingAnchorDay: true,
    },
  });

  let renewed = 0;

  for (const sub of due) {
    // Legacy rows predate the anchor column; their start date IS their anchor,
    // which reproduces the calendar-aligned schedule they already have.
    const anchorDay = sub.billingAnchorDay ?? anchorDayOf(sub.endDate ?? sub.startDate, timezone);
    let closing: Period = { periodStart: sub.startDate, periodEnd: sub.endDate! };
    let rolled = false;

    // Catch up period by period so no closed period goes un-invoiced, however
    // long the cron was down.
    for (let i = 0; i < MAX_CATCHUP_PERIODS && closing.periodEnd.getTime() <= now.getTime(); i++) {
      const next = nextAnchoredPeriod(closing, anchorDay, timezone);
      const closed = closing;

      try {
        // Usage for the period being closed, keyed by its own start — NOT by a
        // calendar month, which used to pull in usage from before the period.
        const usage = await prisma.usageRecord.findUnique({
          where: { hotelId_periodStart: { hotelId: sub.hotelId, periodStart: closed.periodStart } },
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
              periodStart: closed.periodStart,
              periodEnd: closed.periodEnd,
            },
            tx,
          );

          await tx.subscription.update({
            where: { id: sub.id },
            data: {
              startDate: next.periodStart,
              endDate: next.periodEnd,
              // Backfill the anchor onto legacy rows as they roll.
              billingAnchorDay: anchorDay,
            },
          });

          await tx.hotel.update({
            where: { id: sub.hotelId },
            data: { billingStartDate: next.periodStart, billingEndDate: next.periodEnd },
          });
        });

        await recordBillingEvent("subscription.renewed", {
          hotelId: sub.hotelId,
          actorType: "SYSTEM",
          data: {
            subscriptionId: sub.id,
            closedPeriodStart: closed.periodStart.toISOString(),
            newPeriodStart: next.periodStart.toISOString(),
            newPeriodEnd: next.periodEnd.toISOString(),
            billingAnchorDay: anchorDay,
          },
        });

        closing = next;
        rolled = true;
      } catch (err) {
        // One hotel's bad row must not stop the rest of the batch renewing.
        log.error({ err, hotelId: sub.hotelId, subscriptionId: sub.id }, "renewal failed for hotel");
        break;
      }
    }

    if (!rolled) continue;

    invalidateSubscriptionStatusCache(sub.hotelId);
    renewed++;

    const { emitToAdmin } = await import("../realtime/emit");
    emitToAdmin("admin:subscription_changed", {
      hotelId: sub.hotelId,
      planId: sub.planId,
      status: SubscriptionStatus.ACTIVE,
      billingEndDate: closing.periodEnd,
    });
  }

  return renewed;
}

// ── Suspension ───────────────────────────────────────────────────────────────

/**
 * Suspend hotels whose paid period or trial has genuinely lapsed.
 *
 * Unlike the old `expireOverdueSubscriptions`, this also closes the subscription
 * row (which used to be left dangling as if still live), emits the socket event
 * the admin panel needs, and writes an audit record.
 *
 * CRITICALLY, it asks `resolveEffectiveState` — the SAME resolver the API and
 * the middleware use — whether the hotel is actually expired. A stale
 * `billingEndDate` is no longer proof of anything: a trial with a scheduled plan
 * and a paid subscription mid-renewal both have one, and expiring either would
 * suspend a customer who is entitled to service. One source of truth, no second
 * opinion in the cron.
 *
 * NULL `billingEndDate` is still deliberately not matched: those are the legacy
 * "free forever" hotels, and suspending live tenants from a cron with no warning
 * is not a decision a background job gets to make. See scripts/billingBackfillReport.ts.
 */
export async function expireOverdueSubscriptions(now: Date = new Date()): Promise<number> {
  const { timezone } = await getBillingConfig();

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
      const sub = await getCurrentSubscription(hotel.id);
      if (sub) {
        const state = resolveEffectiveState(
          {
            status: sub.status,
            startDate: sub.startDate,
            endDate: sub.endDate,
            autoRenew: sub.autoRenew,
            billingAnchorDay: sub.billingAnchorDay,
            scheduledPlanId: sub.scheduledPlanId,
          },
          now,
          timezone,
        );
        // Converting or renewing — materialisation will catch up. Not expired.
        if (state.status !== SubscriptionStatus.EXPIRED) continue;
      }

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
