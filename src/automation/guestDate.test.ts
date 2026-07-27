import { describe, it, expect } from "vitest";
import {
  parseGuestDateStr,
  resolveRelativeDay,
  parseExplicitDate,
  todayInTZ,
  addDays,
  daysBetween,
} from "./guestDate";

// A fixed instant so every assertion is deterministic:
// 2026-07-27T18:45:00Z → still 27 Jul in UTC, already 28 Jul in Asia/Kolkata (+05:30).
const NOW = new Date("2026-07-27T18:45:00Z");
// 2026-07-26T20:30:00Z → 26 Jul in UTC, but 27 Jul in IST. This is the window
// that used to silently shift bookings back a day.
const LATE_NIGHT_IST = new Date("2026-07-26T20:30:00Z");

describe("todayInTZ", () => {
  it("resolves the calendar day in the hotel's zone, not the server's", () => {
    expect(todayInTZ("UTC", NOW)).toBe("2026-07-27");
    expect(todayInTZ("Asia/Kolkata", NOW)).toBe("2026-07-28");
    expect(todayInTZ("America/New_York", NOW)).toBe("2026-07-27");
  });

  it("falls back to UTC for an invalid zone instead of throwing", () => {
    expect(todayInTZ("Not/AZone", NOW)).toBe("2026-07-27");
  });
});

describe("calendar arithmetic", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-07-27", 2)).toBe("2026-07-29");
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("counts days between, signed", () => {
    expect(daysBetween("2026-07-27", "2026-07-28")).toBe(1);
    expect(daysBetween("2026-07-27", "2026-07-27")).toBe(0);
    expect(daysBetween("2026-07-28", "2026-07-27")).toBe(-1);
  });
});

// ── Bug 1: the reported failure ──────────────────────────────────────────────
describe("relative-day phrases (regression: day-after-tomorrow collapsed onto tomorrow)", () => {
  const today = "2026-07-27";

  it("resolves 'day after tomorrow' to +2, NOT +1", () => {
    expect(resolveRelativeDay("day after tomorrow", today)).toBe("2026-07-29");
  });

  it("is case- and punctuation-insensitive, with or without the article", () => {
    for (const s of [
      "Day after tomorrow",
      "DAY AFTER TOMORROW",
      "the day after tomorrow",
      "  day after tomorrow.",
      "after tomorrow",
      "overmorrow",
    ]) {
      expect(resolveRelativeDay(s, today)).toBe("2026-07-29");
    }
  });

  it("resolves today / tomorrow, including common misspellings", () => {
    expect(resolveRelativeDay("today", today)).toBe("2026-07-27");
    expect(resolveRelativeDay("Tomorrow", today)).toBe("2026-07-28");
    for (const s of ["tommorow", "tommorrow", "tomorow", "tmrw", "tmr"]) {
      expect(resolveRelativeDay(s, today)).toBe("2026-07-28");
    }
  });

  it("resolves counted offsets", () => {
    expect(resolveRelativeDay("in 3 days", today)).toBe("2026-07-30");
    expect(resolveRelativeDay("after 5 days", today)).toBe("2026-08-01");
    expect(resolveRelativeDay("2 days from now", today)).toBe("2026-07-29");
  });

  it("declines phrases it does not own, leaving them to later layers", () => {
    expect(resolveRelativeDay("next friday", today)).toBeNull();
    expect(resolveRelativeDay("25/05/2026", today)).toBeNull();
    expect(resolveRelativeDay("", today)).toBeNull();
  });

  it("THE BUG: check-in 'Tomorrow' and check-out 'Day after tomorrow' differ by one night", () => {
    const ci = parseGuestDateStr("Tomorrow", "Asia/Kolkata", NOW)!;
    const co = parseGuestDateStr("Day after tomorrow", "Asia/Kolkata", NOW)!;
    expect(ci).toBe("2026-07-29");
    expect(co).toBe("2026-07-30");
    expect(daysBetween(ci, co)).toBe(1); // was 0 → "Check-out must be after check-in"
  });
});

// ── Bug 2: timezone day-shift ────────────────────────────────────────────────
describe("timezone correctness (regression: .toISOString() shifted the day)", () => {
  it("resolves 'today' to the hotel's day during the late-night IST window", () => {
    // Server-side UTC says 26 Jul; the hotel in India is already on 27 Jul.
    expect(parseGuestDateStr("today", "Asia/Kolkata", LATE_NIGHT_IST)).toBe("2026-07-27");
    expect(parseGuestDateStr("today", "UTC", LATE_NIGHT_IST)).toBe("2026-07-26");
  });

  it("keeps tomorrow exactly one day after today in every zone", () => {
    for (const tz of ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Kiritimati"]) {
      const t = parseGuestDateStr("today", tz, LATE_NIGHT_IST)!;
      const n = parseGuestDateStr("tomorrow", tz, LATE_NIGHT_IST)!;
      expect(daysBetween(t, n)).toBe(1);
    }
  });

  it("never returns a time component or drifts on repeated parses", () => {
    const d = parseGuestDateStr("tomorrow", "Asia/Kolkata", LATE_NIGHT_IST)!;
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parseGuestDateStr("tomorrow", "Asia/Kolkata", LATE_NIGHT_IST)).toBe(d);
  });
});

// ── Bug 3: DD/MM vs MM/DD ────────────────────────────────────────────────────
describe("explicit numeric dates are day-first (regression: chrono read them US-style)", () => {
  const today = "2026-07-27";

  it("reads an ambiguous DD/MM/YYYY as day-first", () => {
    // Both components <= 12, so this is where the US parser silently disagreed.
    expect(parseExplicitDate("05/06/2026", today)).toBe("2026-06-05"); // 5 June, not 6 May
    expect(parseExplicitDate("01/02/2026", today)).toBe("2026-02-01");
    expect(parseExplicitDate("12/11/2026", today)).toBe("2026-11-12");
  });

  it("accepts the documented DD/MM/YYYY form and its separators", () => {
    expect(parseExplicitDate("25/05/2026", today)).toBe("2026-05-25");
    expect(parseExplicitDate("25-05-2026", today)).toBe("2026-05-25");
    expect(parseExplicitDate("25.05.2026", today)).toBe("2026-05-25");
    expect(parseExplicitDate("5/6/26", today)).toBe("2026-06-05");
  });

  it("still accepts unambiguous ISO YYYY-MM-DD", () => {
    expect(parseExplicitDate("2026-05-25", today)).toBe("2026-05-25");
  });

  it("accepts month names in either order, with ordinals", () => {
    expect(parseExplicitDate("25 May 2026", today)).toBe("2026-05-25");
    expect(parseExplicitDate("May 25 2026", today)).toBe("2026-05-25");
    expect(parseExplicitDate("25th December 2026", today)).toBe("2026-12-25");
    expect(parseExplicitDate("Dec 25 2026", today)).toBe("2026-12-25");
  });

  it("resolves a missing year to the nearest FUTURE occurrence", () => {
    expect(parseExplicitDate("25 May", today)).toBe("2027-05-25"); // May already passed
    expect(parseExplicitDate("25 August", today)).toBe("2026-08-25"); // still ahead
    expect(parseExplicitDate("30/07", today)).toBe("2026-07-30");
  });

  it("rejects impossible calendar dates rather than rolling them over", () => {
    expect(parseExplicitDate("31/02/2026", today)).toBeNull();
    expect(parseExplicitDate("32/01/2026", today)).toBeNull();
    expect(parseExplicitDate("25/13/2026", today)).toBeNull();
    expect(parseExplicitDate("2026-02-30", today)).toBeNull();
  });

  it("handles leap years", () => {
    expect(parseExplicitDate("29/02/2028", today)).toBe("2028-02-29");
    expect(parseExplicitDate("29/02/2027", today)).toBeNull();
  });
});

// ── Layering + end-to-end ────────────────────────────────────────────────────
describe("parseGuestDateStr layering", () => {
  const TZ = "Asia/Kolkata"; // today = 2026-07-28 at NOW

  it("still delegates open-ended phrasing to chrono", () => {
    // today is Tue 2026-07-28 in IST. chrono reads "next friday" as the Friday
    // of the FOLLOWING week (Aug 7), not the upcoming one — its documented
    // behaviour, left intentionally unchanged.
    expect(parseGuestDateStr("next friday", TZ, NOW)).toBe("2026-08-07");
    expect(parseGuestDateStr("this friday", TZ, NOW)).toBe("2026-07-31");
    expect(parseGuestDateStr("in two weeks", TZ, NOW)).toBe("2026-08-11");
  });

  it("returns null for input carrying no date, so the AI fallback can try", () => {
    expect(parseGuestDateStr("hello there", TZ, NOW)).toBeNull();
    expect(parseGuestDateStr("", TZ, NOW)).toBeNull();
    expect(parseGuestDateStr("   ", TZ, NOW)).toBeNull();
  });

  it("tolerates conversational lead-ins", () => {
    expect(parseGuestDateStr("on 25/08/2026", TZ, NOW)).toBe("2026-08-25");
    expect(parseGuestDateStr("check-in is tomorrow", TZ, NOW)).toBe("2026-07-29");
  });

  it("never throws on hostile input", () => {
    for (const s of ["////", "99/99/9999", "0/0/0", "🎉", "a".repeat(500)]) {
      expect(() => parseGuestDateStr(s, TZ, NOW)).not.toThrow();
    }
  });

  it("orders a realistic booking pair correctly for every supported phrasing", () => {
    const pairs: Array<[string, string]> = [
      ["today", "tomorrow"],
      ["tomorrow", "day after tomorrow"],
      ["Tomorrow", "Day after tomorrow"],
      ["25/08/2026", "27/08/2026"],
      ["25 August 2026", "28 August 2026"],
      ["today", "in 3 days"],
    ];
    for (const [ciRaw, coRaw] of pairs) {
      const ci = parseGuestDateStr(ciRaw, TZ, NOW)!;
      const co = parseGuestDateStr(coRaw, TZ, NOW)!;
      expect(ci, `${ciRaw} should parse`).toBeTruthy();
      expect(co, `${coRaw} should parse`).toBeTruthy();
      expect(daysBetween(ci, co), `${ciRaw} → ${coRaw}`).toBeGreaterThan(0);
    }
  });
});
