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
 * BILLING MODEL: calendar-aligned with a prorated first period.
 * The first period runs signup → start of next month and is invoiced pro rata;
 * every period after it is a whole calendar month. This keeps billing periods
 * exactly aligned with UsageRecord's "YYYY-MM" key, so overage math needs no
 * re-keying of the meter.
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

// ── Periods ──────────────────────────────────────────────────────────────────

/**
 * The first (partial) billing period: signup instant → start of next month.
 *
 * This is the fix for the back-dating bug: the period no longer starts before
 * the hotel existed, so `billingEndDate < now` can't fire immediately.
 */
export function computeFirstPeriod(now: Date, timeZone: string = DEFAULT_BILLING_TIMEZONE): Period {
  return { periodStart: now, periodEnd: startOfNextMonthInTZ(now, timeZone) };
}

/** The next whole calendar month following `periodEnd`. Used by renewal. */
export function computeNextPeriod(periodEnd: Date, timeZone: string = DEFAULT_BILLING_TIMEZONE): Period {
  return { periodStart: periodEnd, periodEnd: startOfNextMonthInTZ(periodEnd, timeZone) };
}

/**
 * Pro-rated charge for a partial period, in integer minor units.
 *
 * Charged on **whole days remaining** (ceil, so any part of a day counts) over
 * days-in-month. A full period returns exactly `priceMinor` — never a rounding
 * artefact — because the day counts are equal. Always in [0, priceMinor].
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
