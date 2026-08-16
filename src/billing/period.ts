/**
 * billing/period.ts
 *
 * Pure calendar math for billing periods and usage-month bucketing.
 *
 * Kept dependency-free — imports NOTHING — so it unit-tests without pulling in
 * Prisma/Redis/queues. Mirrors stayDuration.ts / bookingAllocation.ts.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two bugs this replaces, both caused by server-local `new Date(y, m, 1)`:
 *
 * 1. **Back-dated periods.** `assignPlanToHotel` used `startOfMonth(now)` as the
 *    period start and `startOfNextMonth(now)` as the end. A hotel that signed up
 *    on the 28th got THREE DAYS of service before the expiry cron killed it, and
 *    was billed a full month for it. Periods now start at signup and the first
 *    (partial) period is PRORATED.
 *
 * 2. **Server-local month keys.** `usage.service.currentMonth()` and
 *    `analytics.controller` each built "YYYY-MM" from server-local time. Usage
 *    re-buckets into a different month if the container TZ changes, and the two
 *    copies could disagree. Month keys now derive from one configured billing
 *    timezone (PlatformSettings.billingTimezone), using the same
 *    `Intl` + "en-CA" technique as automation/guestDate.ts `todayInTZ`.
 *
 * BILLING MODEL: **anchored monthly periods** (replaced calendar-aligned).
 * ---------------------------------------------------------------------
 * A subscription is anchored to its billing start DAY, not to the calendar
 * month. Anchor 15 gives 15 Aug → 15 Sep → 15 Oct …; anchor 1 gives the old
 * calendar behaviour as a special case, which is why existing hotels are
 * unaffected by the change.
 *
 * Periods are HALF-OPEN `[periodStart, periodEnd)`. `periodEnd` is the exact
 * instant the next period begins — one shared boundary, so chained periods can
 * neither gap nor overlap by construction. We never store a `23:59:59` end.
 * A UI that wants to show an inclusive last day renders `periodEnd - 1ms`.
 *
 * THE ANCHOR IS STORED, NOT RE-DERIVED. `Subscription.billingAnchorDay` keeps
 * the original day-of-month even when a short month clamps it, so
 * 31 Jan → 28 Feb → 31 Mar → 30 Apr → 31 May. Re-deriving the anchor from each
 * clamped period start would ratchet 31 → 28 permanently after one February.
 *
 * The previous model (`computeFirstPeriod` / `computeNextPeriod`: signup →
 * start of next month, then whole calendar months) is GONE. It threw the anchor
 * away after the first period, which is what produced "15 Aug 2026 → 01 Sep
 * 2026" for a subscription that started on the 15th.
 */

/** Fallback when PlatformSettings can't be read. Matches the schema default. */
export const DEFAULT_BILLING_TIMEZONE = "Asia/Kolkata";

/** "YYYY-MM" */
export type MonthKey = string;

export type Period = {
  periodStart: Date;
  periodEnd: Date;
};

// ── Timezone-aware calendar parts ────────────────────────────────────────────

type Parts = { year: number; month: number; day: number };

/**
 * Calendar Y/M/D of `date` as seen in `timeZone`.
 * "en-CA" formats as YYYY-MM-DD, which parses without locale ambiguity —
 * the same trick todayInTZ uses. Falls back to UTC parts on a bad zone name so
 * a misconfigured PlatformSettings row can never throw inside the billing cron.
 */
function partsInTZ(date: Date, timeZone: string): Parts {
  try {
    const s = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
    return {
      year: Number(s.slice(0, 4)),
      month: Number(s.slice(5, 7)),
      day: Number(s.slice(8, 10)),
    };
  } catch {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }
}

/**
 * How far ahead of UTC `timeZone` is at `date`, in ms (IST → +19_800_000).
 *
 * Derived by probing rather than from an offset table: render the instant's
 * wall-clock in the zone, read it back as if it were UTC, and diff. Uses
 * `formatToParts` — a formatted string's separators vary by engine/ICU build.
 */
function tzOffsetMs(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);

    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const hour = get("hour") === 24 ? 0 : get("hour"); // some ICU builds emit 24 for midnight
    const asIfUTC = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
    if (!Number.isFinite(asIfUTC)) return 0;

    // formatToParts has second granularity — drop ms from the reference instant.
    return asIfUTC - (date.getTime() - date.getMilliseconds());
  } catch {
    return 0; // bad zone name → behave as UTC rather than throw inside the cron
  }
}

/**
 * The UTC instant of local midnight for `year-month-day` in `timeZone`.
 *
 * Subtracting the zone offset from the naive UTC midnight lands on local
 * midnight. The second pass settles DST: when the first result crosses a
 * transition, the offset there differs from the offset we corrected by.
 */
function zonedMidnightUTC(year: number, month: number, day: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day);
  let ms = naive - tzOffsetMs(new Date(naive), timeZone);
  ms = naive - tzOffsetMs(new Date(ms), timeZone);
  return new Date(ms);
}

// ── Month keys ───────────────────────────────────────────────────────────────

/**
 * The UsageRecord bucket key for `date` in the platform's billing timezone.
 * THE single definition — usage.service and analytics both call this.
 */
export function monthKey(date: Date, timeZone: string = DEFAULT_BILLING_TIMEZONE): MonthKey {
  const { year, month } = partsInTZ(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Whole days in the calendar month containing `date`, as seen in `timeZone`. */
export function daysInMonth(date: Date, timeZone: string = DEFAULT_BILLING_TIMEZONE): number {
  const { year, month } = partsInTZ(date, timeZone);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Local-midnight instant of the 1st of `date`'s month, in `timeZone`. */
export function startOfMonthInTZ(date: Date, timeZone: string = DEFAULT_BILLING_TIMEZONE): Date {
  const { year, month } = partsInTZ(date, timeZone);
  return zonedMidnightUTC(year, month, 1, timeZone);
}

/** Local-midnight instant of the 1st of the FOLLOWING month, in `timeZone`. */
export function startOfNextMonthInTZ(date: Date, timeZone: string = DEFAULT_BILLING_TIMEZONE): Date {
  const { year, month } = partsInTZ(date, timeZone);
  return month === 12
    ? zonedMidnightUTC(year + 1, 1, 1, timeZone)
    : zonedMidnightUTC(year, month + 1, 1, timeZone);
}

// ── Days ─────────────────────────────────────────────────────────────────────

/** Local-midnight instant of the calendar day containing `date`, in `timeZone`. */
export function startOfDayInTZ(date: Date, timeZone: string = DEFAULT_BILLING_TIMEZONE): Date {
  const { year, month, day } = partsInTZ(date, timeZone);
  return zonedMidnightUTC(year, month, day, timeZone);
}

/**
 * Local midnight `n` calendar days after the day containing `date`.
 *
 * Calendar arithmetic, not `+ n * 86_400_000`: across a DST transition a day is
 * 23 or 25 hours long, and a trial boundary must land on midnight regardless.
 */
export function addDaysInTZ(date: Date, n: number, timeZone: string = DEFAULT_BILLING_TIMEZONE): Date {
  const { year, month, day } = partsInTZ(date, timeZone);
  // Date.UTC normalises overflow (day 32 → the 1st of the next month) for us.
  const shifted = new Date(Date.UTC(year, month - 1, day + n));
  return zonedMidnightUTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), timeZone);
}

// ── Anchored monthly periods ─────────────────────────────────────────────────

/** Day-of-month a subscription recurs on: 1–31. */
export type AnchorDay = number;

/** Coerce anything to a usable anchor day. Junk → 1, the safest anchor. */
export function clampAnchorDay(day: unknown): AnchorDay {
  const n = typeof day === "number" ? Math.trunc(day) : Number.NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.min(31, Math.max(1, n));
}

/** The anchor day implied by an instant, read in `timeZone`. */
export function anchorDayOf(date: Date, timeZone: string = DEFAULT_BILLING_TIMEZONE): AnchorDay {
  return clampAnchorDay(partsInTZ(date, timeZone).day);
}

/** Whole days in a given 1-based calendar month. Handles leap years. */
export function daysInYearMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Shift a 1-based year/month pair by `n` months. Correct for negative `n`. */
function shiftMonth(year: number, month: number, n: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + n;
  const m = ((total % 12) + 12) % 12;
  return { year: Math.floor(total / 12), month: m + 1 };
}

/**
 * Local midnight of the anchor day, `n` months from the month containing
 * `date`, clamped to the target month's length.
 *
 * Clamping is per-month and never mutates the anchor, so an anchor of 31
 * survives February: 31 Jan +1 → 28 Feb, 31 Jan +2 → 31 Mar.
 */
export function addMonthsAnchored(
  date: Date,
  n: number,
  anchorDay: AnchorDay,
  timeZone: string = DEFAULT_BILLING_TIMEZONE,
): Date {
  const { year, month } = partsInTZ(date, timeZone);
  const target = shiftMonth(year, month, n);
  const day = Math.min(clampAnchorDay(anchorDay), daysInYearMonth(target.year, target.month));
  return zonedMidnightUTC(target.year, target.month, day, timeZone);
}

/**
 * The first anchor boundary STRICTLY after `from`.
 *
 * For a period start that already sits on its anchor this is simply +1 month,
 * which is the normal case. It matters when a start is OFF its anchor — after a
 * goodwill extension, or on a legacy row — where "+1 month" can overshoot.
 *
 * Concretely: anchor 15, a period extended to end 5 Oct. `+1 month` reads 5 Oct
 * as October and lands on 15 NOVEMBER, skipping straight past 15 October and
 * handing the customer an extra free month (a measured 41-day period). Asking
 * for the next anchor after 5 Oct correctly gives 15 Oct, so the schedule
 * realigns with one short period instead.
 */
export function nextAnchorAfter(
  from: Date,
  anchorDay: AnchorDay,
  timeZone: string = DEFAULT_BILLING_TIMEZONE,
): Date {
  // This month's own anchor occurrence — usable only if it is still ahead.
  const thisMonth = addMonthsAnchored(from, 0, anchorDay, timeZone);
  if (thisMonth.getTime() > from.getTime()) return thisMonth;
  return addMonthsAnchored(from, 1, anchorDay, timeZone);
}

/**
 * The billing period that begins at `periodStart`.
 *
 * `periodStart` is taken as given (so a legacy row's exact stored start is
 * preserved); the end is the next anchor boundary after it — normally a whole
 * month, and never an overshoot when the start is off-anchor.
 */
export function computeAnchoredPeriod(
  periodStart: Date,
  anchorDay: AnchorDay,
  timeZone: string = DEFAULT_BILLING_TIMEZONE,
): Period {
  return { periodStart, periodEnd: nextAnchorAfter(periodStart, anchorDay, timeZone) };
}

/**
 * The period following `period`. Starts exactly where the previous one ended —
 * the shared boundary that makes gaps and overlaps structurally impossible.
 */
export function nextAnchoredPeriod(
  period: Period,
  anchorDay: AnchorDay,
  timeZone: string = DEFAULT_BILLING_TIMEZONE,
): Period {
  return computeAnchoredPeriod(period.periodEnd, anchorDay, timeZone);
}

/**
 * The period containing `at`, rolling forward from `anchorStart`.
 *
 * This is what makes access ZERO-DELAY: a subscription whose stored period
 * ended while the cron was asleep still resolves to the period it is *actually*
 * in, computed from the clock alone. `at` before `anchorStart` returns the
 * first period — we never invent a period predating the subscription.
 *
 * O(1) in practice: it jumps by whole months first, then corrects by at most
 * one step (the guards are defensive, not load-bearing).
 */
export function periodContaining(
  anchorStart: Date,
  anchorDay: AnchorDay,
  at: Date,
  timeZone: string = DEFAULT_BILLING_TIMEZONE,
): Period {
  let period = computeAnchoredPeriod(anchorStart, anchorDay, timeZone);
  if (at.getTime() < period.periodEnd.getTime()) return period;

  const from = partsInTZ(anchorStart, timeZone);
  const to = partsInTZ(at, timeZone);
  const monthsApart = (to.year * 12 + to.month - 1) - (from.year * 12 + from.month - 1);

  // Land one month short of `at`'s month, then step forward at most once:
  // `at` is either before this period's anchor day (already inside) or after it.
  const jump = Math.max(1, monthsApart - 1);
  period = computeAnchoredPeriod(addMonthsAnchored(anchorStart, jump, anchorDay, timeZone), anchorDay, timeZone);

  let guard = 0;
  while (at.getTime() >= period.periodEnd.getTime() && guard++ < 24) {
    period = nextAnchoredPeriod(period, anchorDay, timeZone);
  }
  while (period.periodStart.getTime() > at.getTime() && guard++ < 24) {
    const previousStart = addMonthsAnchored(period.periodStart, -1, anchorDay, timeZone);
    if (previousStart.getTime() < anchorStart.getTime()) break;
    period = computeAnchoredPeriod(previousStart, anchorDay, timeZone);
  }
  return period;
}

/**
 * How many whole periods separate `anchorStart` from the period containing
 * `at`. 0 while still in the first period. Used to bound catch-up work.
 */
export function periodsElapsed(
  anchorStart: Date,
  anchorDay: AnchorDay,
  at: Date,
  timeZone: string = DEFAULT_BILLING_TIMEZONE,
): number {
  let period = computeAnchoredPeriod(anchorStart, anchorDay, timeZone);
  let n = 0;
  while (at.getTime() >= period.periodEnd.getTime() && n < 600) {
    period = nextAnchoredPeriod(period, anchorDay, timeZone);
    n++;
  }
  return n;
}

/**
 * The last instant belonging to a half-open period — what a UI should format
 * when it wants to show an inclusive end date ("15 Aug → 14 Sep").
 */
export function inclusiveEnd(periodEnd: Date): Date {
  return new Date(periodEnd.getTime() - 1);
}

// ── Proration ────────────────────────────────────────────────────────────────

/**
 * Pro-rated charge for a partial period, in integer minor units.
 *
 * RETAINED BUT NOT ON THE LIVE PATH. Under the anchored model every period —
 * including the first — runs a whole anchored month, so there is nothing to
 * prorate: `assignPlanToHotel` charges the full price. This stays because
 * mid-period plan CHANGES will need it, and that commercial policy is a
 * separate, deliberately deferred piece of work. Do not wire it back into the
 * period math: on an anchored period like 31 Jan → 28 Feb it would under-charge
 * a full month to 28/31.
 *
 * Charged on **whole days remaining** (ceil, so any part of a day counts) over
 * days-in-month. Always in [0, priceMinor].
 */
export function proratePeriod(
  priceMinor: number,
  period: Period,
  timeZone: string = DEFAULT_BILLING_TIMEZONE,
): number {
  if (!Number.isFinite(priceMinor) || priceMinor <= 0) return 0;

  const total = daysInMonth(period.periodStart, timeZone);
  const spanMs = period.periodEnd.getTime() - period.periodStart.getTime();
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 0;

  const remaining = Math.ceil(spanMs / 86_400_000);
  if (remaining >= total) return Math.round(priceMinor);

  return Math.min(Math.round(priceMinor), Math.round((priceMinor * remaining) / total));
}

/** Whole days between two instants, rounded up. Never negative. */
export function daysUntil(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 86_400_000);
}

/** `base` plus whole days. Pure instant arithmetic — no zone reinterpretation. */
export function addDays(base: Date, n: number): Date {
  return new Date(base.getTime() + n * 86_400_000);
}
