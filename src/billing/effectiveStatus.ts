/**
 * billing/effectiveStatus.ts
 *
 * THE definition of "what is this hotel entitled to *right now*".
 *
 * Pure and dependency-free (imports only billing/period) so it unit-tests
 * without Prisma/Redis — same convention as period.ts / overage.ts.
 *
 * WHY THIS EXISTS
 * ---------------
 * Entitlement used to be a denormalised column, `Hotel.subscriptionStatus`,
 * mutated *only* by a cron that runs every 30 minutes and then cached in Redis
 * for another 5. Two consequences, both real:
 *
 *   - a trial that ended at 00:00 kept full paid-tier service until the next
 *     tick, then dropped straight to EXPIRED;
 *   - a paid subscription whose period had rolled kept serving off a stale row,
 *     and if the tick failed it was suspended despite being a paying customer.
 *
 * Access is now derived from the CLOCK. The stored row is an input, not the
 * verdict. The cron's remaining job is *materialisation* — persisting the roll,
 * issuing invoices, sending mail — and if it is late, or down, or has never run,
 * the customer's access is still correct to the millisecond.
 *
 * TERMINAL STATES ARE RESPECTED. EXPIRED and CANCELED are decisions someone (or
 * dunning) made deliberately; this resolver never resurrects them. It only
 * moves state FORWARD in time along a path that was already agreed:
 * a scheduled plan, or an auto-renewing subscription.
 */
import {
  DEFAULT_BILLING_TIMEZONE,
  anchorDayOf,
  clampAnchorDay,
  computeAnchoredPeriod,
  periodContaining,
  type AnchorDay,
  type Period,
} from "./period";

/** Mirrors Prisma's SubscriptionStatus without importing the client. */
export type BillingStatus = "TRIALING" | "ACTIVE" | "PAST_DUE" | "EXPIRED" | "CANCELED";

/** Statuses under which the hotel is still served. */
const SERVED: ReadonlySet<BillingStatus> = new Set<BillingStatus>(["TRIALING", "ACTIVE", "PAST_DUE"]);

/** Statuses nothing may move a subscription out of. */
const TERMINAL: ReadonlySet<BillingStatus> = new Set<BillingStatus>(["EXPIRED", "CANCELED"]);

/** The stored subscription fields this resolver needs. */
export type SubscriptionState = {
  status: BillingStatus;
  /** Current period start (inclusive). */
  startDate: Date;
  /** Current period end (EXCLUSIVE). Null = legacy open-ended row. */
  endDate: Date | null;
  autoRenew: boolean;
  /** Stored anchor. Null on legacy rows → derived from the period boundaries. */
  billingAnchorDay?: number | null;
  /** Plan that begins the instant a trial ends. Null = no paid path. */
  scheduledPlanId?: string | null;
};

export type EffectiveState = {
  /** What the hotel is entitled to at `now`. */
  status: BillingStatus;
  /** Lapsed: writes blocked, bot silenced. */
  suspended: boolean;
  /** In the dunning grace window; still fully served. */
  pastDue: boolean;
  /** The period `now` actually falls in. */
  periodStart: Date;
  /** Exclusive. Null only for legacy open-ended rows. */
  periodEnd: Date | null;
  /** The anchor this subscription recurs on. */
  anchorDay: AnchorDay;
  /**
   * True when the persisted row lags this answer — i.e. the cron owes work
   * (roll the period, create the paid subscription, issue an invoice).
   * Never affects entitlement; it only tells the cron what to do.
   */
  needsMaterialization: boolean;
  /** True when a trial has ended and its scheduled plan is now in force. */
  trialConverted: boolean;
  /**
   * The next instant this answer could change. Null = never (terminal or
   * open-ended). Drives the boundary-clamped cache TTL, so no cached value can
   * outlive the boundary that would invalidate it.
   */
  nextBoundary: Date | null;
  /** Short machine-readable explanation, for logs and tests. */
  reason:
    | "terminal"
    | "open_ended"
    | "within_period"
    | "trial_converted"
    | "trial_lapsed"
    | "renewed"
    | "not_renewing";
};

function serve(status: BillingStatus): { suspended: boolean; pastDue: boolean } {
  return { suspended: !SERVED.has(status), pastDue: status === "PAST_DUE" };
}

/**
 * The anchor to recur on: the stored one, else the day the CURRENT period ends.
 *
 * Deriving from `endDate` rather than `startDate` is what keeps pre-anchor rows
 * on the schedule they already have. A hotel in the old model's partial first
 * period ran e.g. 15 Aug 10:00 → 1 Sep; its next period must start on the 1st,
 * not the 15th. `startDate` would say 15 and silently move the customer's
 * renewal date — and would disagree with what the renewal cron writes.
 */
function derivedAnchor(sub: SubscriptionState, timeZone: string): AnchorDay {
  if (sub.billingAnchorDay != null) return clampAnchorDay(sub.billingAnchorDay);
  return anchorDayOf(sub.endDate ?? sub.startDate, timeZone);
}

/**
 * Resolve a subscription's effective state at `now`.
 *
 * Decision order (each case is mutually exclusive):
 *   1. terminal stored status            → unchanged, forever
 *   2. no end date (legacy open-ended)   → unchanged
 *   3. now < endDate                     → unchanged, stored period
 *   4. trial ended + scheduled plan      → ACTIVE from exactly the trial boundary
 *   5. trial ended, nothing scheduled    → EXPIRED, immediately
 *   6. paid period ended + autoRenew     → same status, period rolled forward
 *   7. paid period ended, no renewal     → EXPIRED, immediately
 */
export function resolveEffectiveState(
  sub: SubscriptionState,
  now: Date,
  timeZone: string = DEFAULT_BILLING_TIMEZONE,
): EffectiveState {
  const anchor = derivedAnchor(sub, timeZone);

  // 1. Terminal — a deliberate decision, never undone by the passage of time.
  if (TERMINAL.has(sub.status)) {
    return {
      status: sub.status,
      ...serve(sub.status),
      periodStart: sub.startDate,
      periodEnd: sub.endDate,
      anchorDay: anchor,
      needsMaterialization: false,
      trialConverted: false,
      nextBoundary: null,
      reason: "terminal",
    };
  }

  // 2. Legacy rows with no end date — the "free forever" tenants. Suspending
  //    them from a resolver is not a decision this function gets to make.
  if (!sub.endDate) {
    return {
      status: sub.status,
      ...serve(sub.status),
      periodStart: sub.startDate,
      periodEnd: null,
      anchorDay: anchor,
      needsMaterialization: false,
      trialConverted: false,
      nextBoundary: null,
      reason: "open_ended",
    };
  }

  // 3. Still inside the stored period — the overwhelmingly common case.
  if (now.getTime() < sub.endDate.getTime()) {
    return {
      status: sub.status,
      ...serve(sub.status),
      periodStart: sub.startDate,
      periodEnd: sub.endDate,
      anchorDay: anchor,
      needsMaterialization: false,
      trialConverted: false,
      nextBoundary: sub.endDate,
      reason: "within_period",
    };
  }

  // ── The period has ended. Is there an agreed path forward? ────────────────

  if (sub.status === "TRIALING") {
    const trialEnd = sub.endDate;

    // 4. Scheduled plan: paid service begins at EXACTLY the trial boundary.
    //    No gap is possible — the paid period's start IS the trial's end.
    if (sub.scheduledPlanId) {
      const paidAnchor = anchorDayOf(trialEnd, timeZone);
      const period = periodContaining(trialEnd, paidAnchor, now, timeZone);
      return {
        status: "ACTIVE",
        ...serve("ACTIVE"),
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        anchorDay: paidAnchor,
        needsMaterialization: true,
        trialConverted: true,
        nextBoundary: period.periodEnd,
        reason: "trial_converted",
      };
    }

    // 5. Trial over with nothing to convert to — suspended from this instant,
    //    not from whenever the cron next wakes up.
    return {
      status: "EXPIRED",
      ...serve("EXPIRED"),
      periodStart: sub.startDate,
      periodEnd: trialEnd,
      anchorDay: anchor,
      needsMaterialization: true,
      trialConverted: false,
      nextBoundary: null,
      reason: "trial_lapsed",
    };
  }

  // 6. A paid subscription that renews. PAST_DUE stays PAST_DUE: it is the
  //    grace window, and only dunning may end it.
  if (sub.autoRenew) {
    // Roll from the boundary the stored period ENDS on, which is where the next
    // period begins. Rolling from `startDate` would re-derive the whole chain
    // and could land on a different schedule than the one the row is on.
    const period = periodContaining(sub.endDate, anchor, now, timeZone);
    return {
      status: sub.status,
      ...serve(sub.status),
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      anchorDay: anchor,
      needsMaterialization: true,
      trialConverted: false,
      nextBoundary: period.periodEnd,
      reason: "renewed",
    };
  }

  // 7. Cancelled at period end, and the period has now ended.
  return {
    status: "EXPIRED",
    ...serve("EXPIRED"),
    periodStart: sub.startDate,
    periodEnd: sub.endDate,
    anchorDay: anchor,
    needsMaterialization: true,
    trialConverted: false,
    nextBoundary: null,
    reason: "not_renewing",
  };
}

/** The period a hotel is in right now, per the resolver. */
export function effectivePeriod(state: EffectiveState): Period | null {
  return state.periodEnd ? { periodStart: state.periodStart, periodEnd: state.periodEnd } : null;
}

/**
 * Cache TTL in whole seconds that CANNOT outlive the next boundary.
 *
 * A cached subscription row is still resolved against a live `now`, so it is
 * already boundary-correct; clamping is defence in depth for anything that
 * caches a derived answer. Floor of 1s — a 0-second TTL means "no expiry" in
 * Redis, which is the opposite of what a boundary in the past should mean.
 */
export function boundedCacheTtlSeconds(
  state: EffectiveState,
  now: Date,
  maxSeconds: number,
): number {
  if (!state.nextBoundary) return maxSeconds;
  const untilBoundary = Math.ceil((state.nextBoundary.getTime() - now.getTime()) / 1000);
  return Math.max(1, Math.min(maxSeconds, untilBoundary));
}

/**
 * The paid period a trial converts into, for callers that need it before the
 * conversion has been materialised (scheduling UI, invoice generation).
 */
export function paidPeriodAfterTrial(
  trialEnd: Date,
  timeZone: string = DEFAULT_BILLING_TIMEZONE,
): { period: Period; anchorDay: AnchorDay } {
  const anchorDay = anchorDayOf(trialEnd, timeZone);
  return { period: computeAnchoredPeriod(trialEnd, anchorDay, timeZone), anchorDay };
}
