import { describe, it, expect, vi } from "vitest";
import {
  nightsBetween,
  exceedsMaxStay,
  DEFAULT_MAX_STAY_NIGHTS,
  HARD_MAX_STAY_NIGHTS,
  STAY_TOO_LONG_MESSAGE,
} from "./stayDuration";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("nightsBetween", () => {
  it("counts nights between two dates", () => {
    expect(nightsBetween(day("2026-06-01"), day("2026-06-04"))).toBe(3);
  });

  it("clamps same-day / reversed ranges to at least 1", () => {
    expect(nightsBetween(day("2026-06-01"), day("2026-06-01"))).toBe(1);
  });

  it("handles an absurd far-future checkout without overflow", () => {
    // ~2000 years out — the OOM-triggering case.
    expect(nightsBetween(day("2026-06-01"), day("4026-06-01"))).toBeGreaterThan(700_000);
  });
});

describe("exceedsMaxStay", () => {
  it("rejects nights over the hotel's configured cap", () => {
    expect(exceedsMaxStay(61, 60)).toBe(true);
  });

  it("accepts nights at or under the configured cap", () => {
    expect(exceedsMaxStay(60, 60)).toBe(false);
    expect(exceedsMaxStay(1, 60)).toBe(false);
  });

  it("falls back to the 60-night default when maxStayNights is unset", () => {
    expect(exceedsMaxStay(61, undefined)).toBe(true);
    expect(exceedsMaxStay(60, undefined)).toBe(false);
    expect(exceedsMaxStay(61, null)).toBe(true);
    expect(DEFAULT_MAX_STAY_NIGHTS).toBe(60);
  });

  it("falls back to the default for non-finite / non-positive configs", () => {
    expect(exceedsMaxStay(61, NaN)).toBe(true);
    expect(exceedsMaxStay(61, 0)).toBe(true);
    expect(exceedsMaxStay(61, -5)).toBe(true);
  });

  it("honours a configured cap above 365 (long-stay business)", () => {
    // A houseboat / serviced apartment configured to 400 nights.
    expect(exceedsMaxStay(400, 400)).toBe(false);
    expect(exceedsMaxStay(380, 400)).toBe(false);
    expect(exceedsMaxStay(401, 400)).toBe(true);
  });

  it("never lets a misconfigured cap exceed the hard 10-year ceiling", () => {
    expect(HARD_MAX_STAY_NIGHTS).toBe(3650);
    // Even with a config above the ceiling, an absurd range is rejected.
    expect(exceedsMaxStay(HARD_MAX_STAY_NIGHTS + 1, 999_999)).toBe(true);
  });
});

// Mirrors the create_booking gate: validation runs BEFORE checkRoomAvailability,
// so an over-long stay must short-circuit without ever touching the DB.
describe("create_booking max-stay gate (gating semantics)", () => {
  // Tiny stand-in for the flowRuntime gate: compute nights, gate, then (only if
  // it passes) call the expensive availability check.
  function bookingGate(
    checkIn: Date,
    checkOut: Date,
    maxStayNights: number | null | undefined,
    checkRoomAvailability: () => { available: boolean },
  ): { message?: string; proceeded: boolean } {
    const nights = nightsBetween(checkIn, checkOut);
    if (exceedsMaxStay(nights, maxStayNights)) {
      return { message: STAY_TOO_LONG_MESSAGE, proceeded: false };
    }
    checkRoomAvailability();
    return { proceeded: true };
  }

  it("nights > maxStayNights → validation message, does NOT call checkRoomAvailability", () => {
    const checkAvail = vi.fn(() => ({ available: true }));
    const res = bookingGate(day("2026-06-01"), day("2030-06-01"), 60, checkAvail);
    expect(res.message).toBe(STAY_TOO_LONG_MESSAGE);
    expect(res.proceeded).toBe(false);
    expect(checkAvail).not.toHaveBeenCalled();
  });

  it("an absurd ~2000-year checkout → validation message, no crash, no availability call", () => {
    const checkAvail = vi.fn(() => ({ available: true }));
    const res = bookingGate(day("2026-06-01"), day("4026-06-01"), 60, checkAvail);
    expect(res.message).toBe(STAY_TOO_LONG_MESSAGE);
    expect(checkAvail).not.toHaveBeenCalled();
  });

  it("nights within the default 60-night limit → proceeds normally (availability called)", () => {
    const checkAvail = vi.fn(() => ({ available: true }));
    const res = bookingGate(day("2026-06-01"), day("2026-06-08"), undefined, checkAvail);
    expect(res.proceeded).toBe(true);
    expect(res.message).toBeUndefined();
    expect(checkAvail).toHaveBeenCalledTimes(1);
  });

  it("hotel configured above 365 (400) → a 400-night booking proceeds", () => {
    const checkAvail = vi.fn(() => ({ available: true }));
    const res = bookingGate(day("2026-06-01"), day("2027-07-06"), 400, checkAvail); // 400 nights
    expect(nightsBetween(day("2026-06-01"), day("2027-07-06"))).toBe(400);
    expect(res.proceeded).toBe(true);
    expect(checkAvail).toHaveBeenCalledTimes(1);
  });
});
