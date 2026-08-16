import { describe, it, expect } from "vitest";
import {
  monthKey,
  daysInMonth,
  daysInYearMonth,
  startOfMonthInTZ,
  startOfNextMonthInTZ,
  startOfDayInTZ,
  addDaysInTZ,
  clampAnchorDay,
  anchorDayOf,
  addMonthsAnchored,
  computeAnchoredPeriod,
  nextAnchoredPeriod,
  periodContaining,
  nextAnchorAfter,
  periodsElapsed,
  inclusiveEnd,
  proratePeriod,
  daysUntil,
  addDays,
  DEFAULT_BILLING_TIMEZONE,
  type Period,
} from "./period";

/** Chain `n` periods from a start instant. Returns [p0, p1, …]. */
function chain(start: Date, anchor: number, n: number, tz: string): Period[] {
  const out: Period[] = [computeAnchoredPeriod(start, anchor, tz)];
  for (let i = 1; i < n; i++) out.push(nextAnchoredPeriod(out[i - 1]!, anchor, tz));
  return out;
}

/** "YYYY-MM-DD" of an instant, as seen in `tz` — readable period assertions. */
function ymd(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const IST = "Asia/Kolkata";
const UTC = "UTC";
const NY = "America/New_York";

describe("monthKey — timezone bucketing", () => {
  it("uses the billing timezone, not the server's", () => {
    // 2026-06-30 20:00 UTC is already 2026-07-01 01:30 in IST.
    const instant = new Date("2026-06-30T20:00:00Z");
    expect(monthKey(instant, UTC)).toBe("2026-06");
    expect(monthKey(instant, IST)).toBe("2026-07");
  });

  it("buckets the IST month boundary correctly on both sides", () => {
    // IST is UTC+5:30 — the month flips at 18:30 UTC on the last day.
    expect(monthKey(new Date("2026-06-30T18:29:00Z"), IST)).toBe("2026-06");
    expect(monthKey(new Date("2026-06-30T18:31:00Z"), IST)).toBe("2026-07");
  });

  it("handles a negative-offset zone (previous day/month)", () => {
    // 2026-07-01 02:00 UTC is still 2026-06-30 22:00 in New York.
    const instant = new Date("2026-07-01T02:00:00Z");
    expect(monthKey(instant, UTC)).toBe("2026-07");
    expect(monthKey(instant, NY)).toBe("2026-06");
  });

  it("zero-pads single-digit months", () => {
    expect(monthKey(new Date("2026-01-15T12:00:00Z"), UTC)).toBe("2026-01");
    expect(monthKey(new Date("2026-09-15T12:00:00Z"), UTC)).toBe("2026-09");
  });

  it("falls back to UTC parts rather than throwing on a bad zone name", () => {
    expect(monthKey(new Date("2026-03-15T12:00:00Z"), "Not/AZone")).toBe("2026-03");
  });

  it("defaults to the platform billing timezone", () => {
    const instant = new Date("2026-06-30T20:00:00Z");
    expect(monthKey(instant)).toBe(monthKey(instant, DEFAULT_BILLING_TIMEZONE));
  });
});

describe("daysInMonth", () => {
  it("covers 31/30/28 day months", () => {
    expect(daysInMonth(new Date("2026-01-10T00:00:00Z"), UTC)).toBe(31);
    expect(daysInMonth(new Date("2026-04-10T00:00:00Z"), UTC)).toBe(30);
    expect(daysInMonth(new Date("2026-02-10T00:00:00Z"), UTC)).toBe(28);
  });

  it("handles leap years", () => {
    expect(daysInMonth(new Date("2028-02-10T00:00:00Z"), UTC)).toBe(29);
    // 2000 is a leap year (divisible by 400); 1900 was not.
    expect(daysInMonth(new Date("2000-02-10T00:00:00Z"), UTC)).toBe(29);
  });

  it("uses the billing timezone to decide which month it is in", () => {
    // 2026-01-31 20:00 UTC is 2026-02-01 in IST → February, 28 days.
    const instant = new Date("2026-01-31T20:00:00Z");
    expect(daysInMonth(instant, UTC)).toBe(31);
    expect(daysInMonth(instant, IST)).toBe(28);
  });
});

describe("startOfMonthInTZ / startOfNextMonthInTZ", () => {
  it("returns local midnight of the 1st", () => {
    const start = startOfMonthInTZ(new Date("2026-06-17T09:00:00Z"), IST);
    // IST midnight on 1 June = 2026-05-31T18:30:00Z
    expect(start.toISOString()).toBe("2026-05-31T18:30:00.000Z");
    expect(monthKey(start, IST)).toBe("2026-06");
  });

  it("returns local midnight of the 1st of next month", () => {
    const next = startOfNextMonthInTZ(new Date("2026-06-17T09:00:00Z"), IST);
    expect(next.toISOString()).toBe("2026-06-30T18:30:00.000Z");
    expect(monthKey(next, IST)).toBe("2026-07");
  });

  it("rolls the year over December → January", () => {
    const next = startOfNextMonthInTZ(new Date("2026-12-17T09:00:00Z"), UTC);
    expect(next.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("lands on the 1st for a DST-shifting zone", () => {
    // US DST starts 2026-03-08; the period boundary must still be Mar 1 local.
    const start = startOfMonthInTZ(new Date("2026-03-20T12:00:00Z"), NY);
    expect(monthKey(start, NY)).toBe("2026-03");
    const next = startOfNextMonthInTZ(new Date("2026-03-20T12:00:00Z"), NY);
    expect(monthKey(next, NY)).toBe("2026-04");
  });
});

describe("startOfDayInTZ / addDaysInTZ", () => {
  it("snaps to local midnight of the containing day", () => {
    expect(startOfDayInTZ(new Date("2026-08-15T09:00:00Z"), IST).toISOString()).toBe("2026-08-14T18:30:00.000Z");
    expect(startOfDayInTZ(new Date("2026-08-15T09:00:00Z"), UTC).toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("adds whole CALENDAR days, so a DST day is still one day", () => {
    // 2026-03-08 is the US spring-forward (a 23-hour local day).
    const from = new Date("2026-03-07T17:00:00Z"); // 12:00 EST on the 7th
    const next = addDaysInTZ(from, 1, NY);
    expect(ymd(next, NY)).toBe("2026-03-08");
    expect(ymd(addDaysInTZ(from, 2, NY), NY)).toBe("2026-03-09");
  });

  it("rolls month and year boundaries", () => {
    expect(ymd(addDaysInTZ(new Date("2026-01-31T12:00:00Z"), 1, UTC), UTC)).toBe("2026-02-01");
    expect(ymd(addDaysInTZ(new Date("2026-12-31T12:00:00Z"), 1, UTC), UTC)).toBe("2027-01-01");
    expect(ymd(addDaysInTZ(new Date("2026-08-15T12:00:00Z"), 14, IST), IST)).toBe("2026-08-29");
  });
});

describe("anchor day helpers", () => {
  it("clamps junk to a safe anchor", () => {
    expect(clampAnchorDay(15)).toBe(15);
    expect(clampAnchorDay(0)).toBe(1);
    expect(clampAnchorDay(99)).toBe(31);
    expect(clampAnchorDay(null)).toBe(1);
    expect(clampAnchorDay(undefined)).toBe(1);
    expect(clampAnchorDay(NaN)).toBe(1);
    expect(clampAnchorDay(15.9)).toBe(15);
  });

  it("reads the anchor in the billing timezone, not the server's", () => {
    // 2026-08-14 20:00 UTC is already the 15th in IST.
    const instant = new Date("2026-08-14T20:00:00Z");
    expect(anchorDayOf(instant, UTC)).toBe(14);
    expect(anchorDayOf(instant, IST)).toBe(15);
  });

  it("daysInYearMonth covers 31/30/28/29", () => {
    expect(daysInYearMonth(2026, 1)).toBe(31);
    expect(daysInYearMonth(2026, 4)).toBe(30);
    expect(daysInYearMonth(2026, 2)).toBe(28);
    expect(daysInYearMonth(2028, 2)).toBe(29);
    expect(daysInYearMonth(2000, 2)).toBe(29);
    expect(daysInYearMonth(1900, 2)).toBe(28);
  });
});

describe("anchored periods — the reported 15 Aug → 01 Sep bug", () => {
  it("a subscription starting on the 15th runs 15 Aug → 15 Sep internally", () => {
    const start = new Date("2026-08-15T00:00:00Z");
    const p = computeAnchoredPeriod(start, 15, UTC);

    expect(p.periodStart.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    // The OLD model produced 2026-09-01 here — the reported bug.
    expect(p.periodEnd.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    // Displayed inclusively: 15 Aug → 14 Sep.
    expect(ymd(inclusiveEnd(p.periodEnd), UTC)).toBe("2026-09-14");
  });

  it("the next period is 15 Sep → 15 Oct, displayed 15 Sep → 14 Oct", () => {
    const first = computeAnchoredPeriod(new Date("2026-08-15T00:00:00Z"), 15, UTC);
    const second = nextAnchoredPeriod(first, 15, UTC);

    expect(second.periodStart.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(second.periodEnd.toISOString()).toBe("2026-10-15T00:00:00.000Z");
    expect(ymd(inclusiveEnd(second.periodEnd), UTC)).toBe("2026-10-14");
  });

  it("chains 15 Aug → 14 Sep → 14 Oct → 14 Nov as specified", () => {
    const [p1, p2, p3, p4] = chain(new Date("2026-08-15T00:00:00Z"), 15, 4, UTC);
    const inclusive = (p: Period) => ymd(inclusiveEnd(p.periodEnd), UTC);

    expect([ymd(p1!.periodStart, UTC), inclusive(p1!)]).toEqual(["2026-08-15", "2026-09-14"]);
    expect([ymd(p2!.periodStart, UTC), inclusive(p2!)]).toEqual(["2026-09-15", "2026-10-14"]);
    expect([ymd(p3!.periodStart, UTC), inclusive(p3!)]).toEqual(["2026-10-15", "2026-11-14"]);
    expect([ymd(p4!.periodStart, UTC), inclusive(p4!)]).toEqual(["2026-11-15", "2026-12-14"]);
  });
});

describe("anchored periods — every anchor day", () => {
  it("anchor 1 reproduces whole calendar months (existing hotels unchanged)", () => {
    const [p1, p2, p3] = chain(new Date("2026-08-01T00:00:00Z"), 1, 3, UTC);
    expect(p1!.periodEnd.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(p2!.periodEnd.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(p3!.periodEnd.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    // 1 Aug → 31 Aug displayed, 1 Sep → 30 Sep, exactly as the spec's example.
    expect(ymd(inclusiveEnd(p1!.periodEnd), UTC)).toBe("2026-08-31");
    expect(ymd(inclusiveEnd(p2!.periodEnd), UTC)).toBe("2026-09-30");
  });

  it("anchor 28 is stable in every month, February included", () => {
    const starts = chain(new Date("2026-12-28T00:00:00Z"), 28, 4, UTC).map((p) => ymd(p.periodStart, UTC));
    expect(starts).toEqual(["2026-12-28", "2027-01-28", "2027-02-28", "2027-03-28"]);
  });

  it("anchor 29 clamps in a common February and recovers to 29", () => {
    const starts = chain(new Date("2027-01-29T00:00:00Z"), 29, 4, UTC).map((p) => ymd(p.periodStart, UTC));
    expect(starts).toEqual(["2027-01-29", "2027-02-28", "2027-03-29", "2027-04-29"]);
  });

  it("anchor 29 lands exactly on 29 Feb in a leap year", () => {
    const starts = chain(new Date("2028-01-29T00:00:00Z"), 29, 4, UTC).map((p) => ymd(p.periodStart, UTC));
    expect(starts).toEqual(["2028-01-29", "2028-02-29", "2028-03-29", "2028-04-29"]);
  });

  it("anchor 30 clamps to 28/29 Feb and recovers to 30", () => {
    expect(chain(new Date("2026-01-30T00:00:00Z"), 30, 4, UTC).map((p) => ymd(p.periodStart, UTC)))
      .toEqual(["2026-01-30", "2026-02-28", "2026-03-30", "2026-04-30"]);
    expect(chain(new Date("2028-01-30T00:00:00Z"), 30, 3, UTC).map((p) => ymd(p.periodStart, UTC)))
      .toEqual(["2028-01-30", "2028-02-29", "2028-03-30"]);
  });

  it("anchor 31 survives February — it does NOT become 28 forever", () => {
    // The headline anchor-preservation rule: 31 Jan → 28 Feb → 31 Mar → 30 Apr → 31 May.
    const starts = chain(new Date("2026-01-31T00:00:00Z"), 31, 5, UTC).map((p) => ymd(p.periodStart, UTC));
    expect(starts).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  it("anchor 31 through a leap February", () => {
    const starts = chain(new Date("2028-01-31T00:00:00Z"), 31, 4, UTC).map((p) => ymd(p.periodStart, UTC));
    expect(starts).toEqual(["2028-01-31", "2028-02-29", "2028-03-31", "2028-04-30"]);
  });

  it("rolls the year over December → January", () => {
    const [p1, p2] = chain(new Date("2026-12-15T00:00:00Z"), 15, 2, UTC);
    expect(ymd(p1!.periodEnd, UTC)).toBe("2027-01-15");
    expect(ymd(p2!.periodEnd, UTC)).toBe("2027-02-15");
  });
});

describe("anchored periods — no gaps, no overlaps", () => {
  it("every period ends exactly where the next begins", () => {
    for (const anchor of [1, 15, 28, 29, 30, 31]) {
      const periods = chain(new Date(`2026-01-${String(Math.min(anchor, 31)).padStart(2, "0")}T00:00:00Z`), anchor, 26, UTC);
      for (let i = 1; i < periods.length; i++) {
        expect(periods[i]!.periodStart.getTime()).toBe(periods[i - 1]!.periodEnd.getTime());
      }
    }
  });

  it("a period always moves forward — never zero-length or reversed", () => {
    for (const anchor of [1, 15, 28, 29, 30, 31]) {
      for (const p of chain(new Date("2027-01-01T00:00:00Z"), anchor, 26, UTC)) {
        expect(p.periodEnd.getTime()).toBeGreaterThan(p.periodStart.getTime());
      }
    }
  });

  it("every day of a year falls in exactly one period", () => {
    const anchorStart = new Date("2026-01-31T00:00:00Z");
    const periods = chain(anchorStart, 31, 15, UTC);

    for (let d = 0; d < 365; d++) {
      const at = new Date(anchorStart.getTime() + d * 86_400_000 + 3_600_000);
      const hits = periods.filter((p) => at >= p.periodStart && at < p.periodEnd);
      expect(hits).toHaveLength(1);
    }
  });

  it("boundary instants belong to the LATER period (half-open)", () => {
    const [p1, p2] = chain(new Date("2026-08-15T00:00:00Z"), 15, 2, UTC);
    const boundary = p1!.periodEnd;
    expect(boundary >= p1!.periodStart && boundary < p1!.periodEnd).toBe(false);
    expect(boundary >= p2!.periodStart && boundary < p2!.periodEnd).toBe(true);
  });
});

describe("anchored periods — timezone and DST", () => {
  it("boundaries are local midnight in the billing timezone", () => {
    const p = computeAnchoredPeriod(new Date("2026-08-14T18:30:00Z"), 15, IST); // 15 Aug 00:00 IST
    expect(p.periodStart.toISOString()).toBe("2026-08-14T18:30:00.000Z");
    expect(p.periodEnd.toISOString()).toBe("2026-09-14T18:30:00.000Z"); // 15 Sep 00:00 IST
    expect(ymd(p.periodStart, IST)).toBe("2026-08-15");
    expect(ymd(p.periodEnd, IST)).toBe("2026-09-15");
  });

  it("stays on the anchor day across a DST transition", () => {
    // US DST starts 2026-03-08 and ends 2026-11-01; the 15th must stay the 15th.
    const starts = chain(new Date("2026-02-15T05:00:00Z"), 15, 12, NY).map((p) => ymd(p.periodStart, NY));
    expect(starts.every((s) => s.endsWith("-15"))).toBe(true);
    // The UTC offset genuinely changes — proving the boundary was recomputed.
    const periods = chain(new Date("2026-02-15T05:00:00Z"), 15, 12, NY);
    const offsets = new Set(periods.map((p) => p.periodStart.toISOString().slice(11, 16)));
    expect(offsets.size).toBeGreaterThan(1);
  });

  it("a negative-offset zone anchors on its own local day", () => {
    // 2026-08-15 02:00 UTC is still 14 Aug in New York.
    const instant = new Date("2026-08-15T02:00:00Z");
    expect(anchorDayOf(instant, UTC)).toBe(15);
    expect(anchorDayOf(instant, NY)).toBe(14);
  });
});

describe("periodContaining — zero-delay period resolution", () => {
  const anchorStart = new Date("2026-08-15T00:00:00Z");

  it("returns the first period while still inside it", () => {
    const p = periodContaining(anchorStart, 15, new Date("2026-08-20T12:00:00Z"), UTC);
    expect(p.periodStart.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(p.periodEnd.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("rolls forward without any cron when the stored period has lapsed", () => {
    const p = periodContaining(anchorStart, 15, new Date("2026-09-20T12:00:00Z"), UTC);
    expect(p.periodStart.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(p.periodEnd.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("catches up across many missed periods in one call", () => {
    const p = periodContaining(anchorStart, 15, new Date("2027-06-20T12:00:00Z"), UTC);
    expect(p.periodStart.toISOString()).toBe("2027-06-15T00:00:00.000Z");
    expect(p.periodEnd.toISOString()).toBe("2027-07-15T00:00:00.000Z");
  });

  it("lands exactly on a boundary in the NEW period", () => {
    const p = periodContaining(anchorStart, 15, new Date("2026-09-15T00:00:00Z"), UTC);
    expect(p.periodStart.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("never returns a period before the subscription started", () => {
    const p = periodContaining(anchorStart, 15, new Date("2026-01-01T00:00:00Z"), UTC);
    expect(p.periodStart.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("preserves a clamped anchor while catching up (31 Jan across Feb)", () => {
    const p = periodContaining(new Date("2026-01-31T00:00:00Z"), 31, new Date("2026-03-15T00:00:00Z"), UTC);
    // Feb period is 28 Feb → 31 Mar; 15 Mar is inside it.
    expect(ymd(p.periodStart, UTC)).toBe("2026-02-28");
    expect(ymd(p.periodEnd, UTC)).toBe("2026-03-31");
  });

  it("preserves a legacy period start that carries a time-of-day", () => {
    const legacy = new Date("2026-08-15T10:37:02.418Z");
    const p = periodContaining(legacy, 15, new Date("2026-08-20T00:00:00Z"), UTC);
    expect(p.periodStart.toISOString()).toBe(legacy.toISOString());
  });

  it("agrees with the chained sequence for a full year", () => {
    for (const anchor of [1, 15, 28, 31]) {
      const start = new Date(`2026-01-${String(Math.min(anchor, 28)).padStart(2, "0")}T00:00:00Z`);
      for (const p of chain(start, anchor, 12, UTC)) {
        const mid = new Date((p.periodStart.getTime() + p.periodEnd.getTime()) / 2);
        const resolved = periodContaining(start, anchor, mid, UTC);
        expect(resolved.periodStart.getTime()).toBe(p.periodStart.getTime());
        expect(resolved.periodEnd.getTime()).toBe(p.periodEnd.getTime());
      }
    }
  });
});

describe("goodwill extensions — realign, never overshoot", () => {
  // An extension moves only this period's end. The NEXT period must run from
  // that extended end to the next anchor occurrence, so the customer returns to
  // their normal billing day with one short period.
  const extend = (end: string, days: number) => new Date(Date.parse(end) + days * 86_400_000);
  const span = (p: Period) => Math.round((p.periodEnd.getTime() - p.periodStart.getTime()) / 86_400_000);

  it("never grants a period longer than one month, whatever the extension", () => {
    for (let n = 1; n <= 60; n++) {
      const p = computeAnchoredPeriod(extend("2026-09-15T00:00:00Z", n), 15, UTC);
      expect(span(p)).toBeLessThanOrEqual(31);
      expect(span(p)).toBeGreaterThan(0);
    }
  });

  it("realigns to the anchor when the extended end passes it", () => {
    // +5d → ends 20 Sep, next anchor is 15 Oct: a 25-day catch-up period.
    const p = computeAnchoredPeriod(extend("2026-09-15T00:00:00Z", 5), 15, UTC);
    expect(ymd(p.periodStart, UTC)).toBe("2026-09-20");
    expect(ymd(p.periodEnd, UTC)).toBe("2026-10-15");
    expect(span(p)).toBe(25);
  });

  it("does NOT skip a whole month when the extended end lands before the anchor", () => {
    // +20d → ends 5 Oct, which is BEFORE anchor day 15 in its own month.
    // `+1 month` used to jump to 15 Nov — a 41-day period, i.e. a free month.
    const p = computeAnchoredPeriod(extend("2026-09-15T00:00:00Z", 20), 15, UTC);
    expect(ymd(p.periodStart, UTC)).toBe("2026-10-05");
    expect(ymd(p.periodEnd, UTC)).toBe("2026-10-15");
    expect(span(p)).toBe(10);
  });

  it("an extension landing exactly on the anchor gives a clean whole month", () => {
    const p = computeAnchoredPeriod(extend("2026-09-15T00:00:00Z", 30), 15, UTC);
    expect(ymd(p.periodStart, UTC)).toBe("2026-10-15");
    expect(ymd(p.periodEnd, UTC)).toBe("2026-11-15");
    expect(span(p)).toBe(31);
  });

  it("an extension past the next anchor still returns to the anchor after it", () => {
    const p = computeAnchoredPeriod(extend("2026-09-15T00:00:00Z", 45), 15, UTC);
    expect(ymd(p.periodStart, UTC)).toBe("2026-10-30");
    expect(ymd(p.periodEnd, UTC)).toBe("2026-11-15");
  });

  it("resumes exact monthly periods once realigned", () => {
    const afterExtension = computeAnchoredPeriod(extend("2026-09-15T00:00:00Z", 20), 15, UTC);
    const [a, b] = [
      nextAnchoredPeriod(afterExtension, 15, UTC),
      nextAnchoredPeriod(nextAnchoredPeriod(afterExtension, 15, UTC), 15, UTC),
    ];
    expect([ymd(a.periodStart, UTC), ymd(a.periodEnd, UTC)]).toEqual(["2026-10-15", "2026-11-15"]);
    expect([ymd(b.periodStart, UTC), ymd(b.periodEnd, UTC)]).toEqual(["2026-11-15", "2026-12-15"]);
  });

  it("still has no gap across the extension", () => {
    const extendedEnd = extend("2026-09-15T00:00:00Z", 20);
    const p = computeAnchoredPeriod(extendedEnd, 15, UTC);
    expect(p.periodStart.getTime()).toBe(extendedEnd.getTime());
  });
});

describe("nextAnchorAfter", () => {
  it("is strictly after — a start already on its anchor moves a full month", () => {
    const onAnchor = new Date("2026-08-15T00:00:00Z");
    expect(ymd(nextAnchorAfter(onAnchor, 15, UTC), UTC)).toBe("2026-09-15");
  });

  it("returns this month's anchor when it is still ahead", () => {
    expect(ymd(nextAnchorAfter(new Date("2026-10-05T00:00:00Z"), 15, UTC), UTC)).toBe("2026-10-15");
  });

  it("respects clamping for a 31 anchor", () => {
    expect(ymd(nextAnchorAfter(new Date("2026-02-05T00:00:00Z"), 31, UTC), UTC)).toBe("2026-02-28");
    expect(ymd(nextAnchorAfter(new Date("2026-02-28T00:00:00Z"), 31, UTC), UTC)).toBe("2026-03-31");
  });
});

describe("periodsElapsed", () => {
  const anchorStart = new Date("2026-08-15T00:00:00Z");

  it("is 0 inside the first period and on its opening instant", () => {
    expect(periodsElapsed(anchorStart, 15, anchorStart, UTC)).toBe(0);
    expect(periodsElapsed(anchorStart, 15, new Date("2026-09-14T23:59:59Z"), UTC)).toBe(0);
  });

  it("counts each crossed boundary", () => {
    expect(periodsElapsed(anchorStart, 15, new Date("2026-09-15T00:00:00Z"), UTC)).toBe(1);
    expect(periodsElapsed(anchorStart, 15, new Date("2026-11-20T00:00:00Z"), UTC)).toBe(3);
  });
});

describe("proratePeriod — retained, off the live path", () => {
  const price = 249900; // ₹2,499.00 in paise

  // Partial periods no longer occur in the anchored model (every period is a
  // whole anchored month), so these build them literally. Kept because
  // mid-period plan changes — deliberately deferred — will need this helper.
  const partial = (from: string, to: string): Period => ({
    periodStart: new Date(from),
    periodEnd: new Date(to),
  });

  it("charges the full price for a whole month", () => {
    expect(proratePeriod(price, partial("2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z"), UTC)).toBe(price);
  });

  it("charges pro rata for a late-month start", () => {
    // 3 days remaining of a 30-day June.
    expect(proratePeriod(price, partial("2026-06-28T00:00:00Z", "2026-07-01T00:00:00Z"), UTC))
      .toBe(Math.round((price * 3) / 30));
  });

  it("counts a part-day as a whole day (customer is never under-served)", () => {
    // 2.5 days left → billed as 3.
    expect(proratePeriod(price, partial("2026-06-28T12:00:00Z", "2026-07-01T00:00:00Z"), UTC))
      .toBe(Math.round((price * 3) / 30));
  });

  it("returns an integer number of minor units", () => {
    const amount = proratePeriod(price, partial("2026-02-17T08:13:00Z", "2026-03-01T00:00:00Z"), UTC);
    expect(Number.isInteger(amount)).toBe(true);
  });

  it("never exceeds the full price", () => {
    for (const day of [1, 5, 14, 27, 28]) {
      const p = partial(`2026-02-${String(day).padStart(2, "0")}T00:00:00Z`, "2026-03-01T00:00:00Z");
      expect(proratePeriod(price, p, UTC)).toBeLessThanOrEqual(price);
    }
  });

  it("prorates against the correct month length (Feb vs Jan)", () => {
    const feb = partial("2026-02-15T00:00:00Z", "2026-03-01T00:00:00Z"); // 14 of 28
    const jan = partial("2026-01-15T00:00:00Z", "2026-02-01T00:00:00Z"); // 17 of 31
    expect(proratePeriod(price, feb, UTC)).toBe(Math.round((price * 14) / 28));
    expect(proratePeriod(price, jan, UTC)).toBe(Math.round((price * 17) / 31));
  });

  it("is 0 for a free plan, a zero-length period, or a bad price", () => {
    const p = partial("2026-06-15T00:00:00Z", "2026-07-01T00:00:00Z");
    expect(proratePeriod(0, p, UTC)).toBe(0);
    expect(proratePeriod(NaN, p, UTC)).toBe(0);
    expect(proratePeriod(-100, p, UTC)).toBe(0);
    expect(proratePeriod(price, { periodStart: p.periodEnd, periodEnd: p.periodStart }, UTC)).toBe(0);
  });
});

describe("daysUntil / addDays", () => {
  it("counts whole days ahead, rounding up", () => {
    expect(daysUntil(new Date("2026-06-01T00:00:00Z"), new Date("2026-06-08T00:00:00Z"))).toBe(7);
    expect(daysUntil(new Date("2026-06-01T00:00:00Z"), new Date("2026-06-08T06:00:00Z"))).toBe(8);
  });

  it("is 0 for a past or equal instant — never negative", () => {
    expect(daysUntil(new Date("2026-06-10T00:00:00Z"), new Date("2026-06-01T00:00:00Z"))).toBe(0);
    expect(daysUntil(new Date("2026-06-01T00:00:00Z"), new Date("2026-06-01T00:00:00Z"))).toBe(0);
  });

  it("addDays shifts by exact whole days", () => {
    expect(addDays(new Date("2026-06-01T09:30:00Z"), 7).toISOString()).toBe("2026-06-08T09:30:00.000Z");
    expect(addDays(new Date("2026-06-08T09:30:00Z"), -7).toISOString()).toBe("2026-06-01T09:30:00.000Z");
  });
});
