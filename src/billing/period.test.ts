import { describe, it, expect } from "vitest";
import {
  monthKey,
  daysInMonth,
  startOfMonthInTZ,
  startOfNextMonthInTZ,
  computeFirstPeriod,
  computeNextPeriod,
  proratePeriod,
  daysUntil,
  addDays,
  DEFAULT_BILLING_TIMEZONE,
} from "./period";

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

describe("computeFirstPeriod — the back-dating bug", () => {
  it("starts at signup, NOT at the start of the month", () => {
    const signup = new Date("2026-06-28T10:00:00Z");
    const { periodStart, periodEnd } = computeFirstPeriod(signup, UTC);

    // The old code used startOfMonth(now) here, which is what let
    // `billingEndDate < now` fire ~3 days after a late-month signup.
    expect(periodStart).toEqual(signup);
    expect(periodStart.getTime()).toBeGreaterThan(new Date("2026-06-01T00:00:00Z").getTime());
    expect(periodEnd.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("never produces a period that has already ended", () => {
    for (const day of ["01", "15", "28", "30"]) {
      const signup = new Date(`2026-06-${day}T23:00:00Z`);
      const { periodEnd } = computeFirstPeriod(signup, UTC);
      expect(periodEnd.getTime()).toBeGreaterThan(signup.getTime());
    }
  });
});

describe("computeNextPeriod — renewal", () => {
  it("chains whole calendar months with no gap or overlap", () => {
    const first = computeFirstPeriod(new Date("2026-06-28T10:00:00Z"), UTC);
    const second = computeNextPeriod(first.periodEnd, UTC);
    const third = computeNextPeriod(second.periodEnd, UTC);

    expect(second.periodStart).toEqual(first.periodEnd);
    expect(second.periodEnd.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(third.periodStart).toEqual(second.periodEnd);
    expect(third.periodEnd.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("each renewed period maps to exactly one usage month", () => {
    const p = computeNextPeriod(new Date("2026-07-01T00:00:00Z"), UTC);
    expect(monthKey(p.periodStart, UTC)).toBe("2026-07");
    // periodEnd is exclusive — it is the first instant of the NEXT bucket.
    expect(monthKey(new Date(p.periodEnd.getTime() - 1), UTC)).toBe("2026-07");
  });
});

describe("proratePeriod", () => {
  const price = 249900; // ₹2,499.00 in paise

  it("charges the full price for a whole month", () => {
    const full = { periodStart: new Date("2026-06-01T00:00:00Z"), periodEnd: new Date("2026-07-01T00:00:00Z") };
    expect(proratePeriod(price, full, UTC)).toBe(price);
  });

  it("charges pro rata for a late-month signup", () => {
    // 3 days remaining of a 30-day June.
    const partial = computeFirstPeriod(new Date("2026-06-28T00:00:00Z"), UTC);
    expect(proratePeriod(price, partial, UTC)).toBe(Math.round((price * 3) / 30));
  });

  it("counts a part-day as a whole day (guest is never under-served)", () => {
    // 2.5 days left → billed as 3.
    const partial = computeFirstPeriod(new Date("2026-06-28T12:00:00Z"), UTC);
    expect(proratePeriod(price, partial, UTC)).toBe(Math.round((price * 3) / 30));
  });

  it("returns an integer number of minor units", () => {
    const partial = computeFirstPeriod(new Date("2026-02-17T08:13:00Z"), UTC);
    const amount = proratePeriod(price, partial, UTC);
    expect(Number.isInteger(amount)).toBe(true);
  });

  it("never exceeds the full price", () => {
    for (const day of [1, 5, 14, 27, 28]) {
      const partial = computeFirstPeriod(new Date(`2026-02-${String(day).padStart(2, "0")}T00:00:00Z`), UTC);
      expect(proratePeriod(price, partial, UTC)).toBeLessThanOrEqual(price);
    }
  });

  it("prorates against the correct month length (Feb vs Jan)", () => {
    const feb = computeFirstPeriod(new Date("2026-02-15T00:00:00Z"), UTC); // 14 of 28
    const jan = computeFirstPeriod(new Date("2026-01-15T00:00:00Z"), UTC); // 17 of 31
    expect(proratePeriod(price, feb, UTC)).toBe(Math.round((price * 14) / 28));
    expect(proratePeriod(price, jan, UTC)).toBe(Math.round((price * 17) / 31));
  });

  it("is 0 for a free plan, a zero-length period, or a bad price", () => {
    const p = computeFirstPeriod(new Date("2026-06-15T00:00:00Z"), UTC);
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
