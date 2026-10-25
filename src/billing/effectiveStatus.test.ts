/**
 * The zero-delay entitlement contract.
 *
 * Every case here must hold with NO cron having run: the resolver is given a
 * stale stored row and a clock, and must produce the state the customer is
 * actually entitled to. `needsMaterialization` records the bookkeeping the cron
 * still owes — it must never be what grants or withholds access.
 */
import { describe, it, expect } from "vitest";
import {
  resolveEffectiveState,
  boundedCacheTtlSeconds,
  paidPeriodAfterTrial,
  type SubscriptionState,
} from "./effectiveStatus";

const UTC = "UTC";
const IST = "Asia/Kolkata";

const TRIAL_START = new Date("2026-08-15T00:00:00Z");
const TRIAL_END = new Date("2026-08-29T00:00:00Z"); // exclusive

function trial(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    status: "TRIALING",
    startDate: TRIAL_START,
    endDate: TRIAL_END,
    autoRenew: false,
    billingAnchorDay: 15,
    scheduledPlanId: null,
    ...overrides,
  };
}

function paid(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    status: "ACTIVE",
    startDate: new Date("2026-08-15T00:00:00Z"),
    endDate: new Date("2026-09-15T00:00:00Z"),
    autoRenew: true,
    billingAnchorDay: 15,
    scheduledPlanId: null,
    ...overrides,
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe("trial — before, at, and after the boundary", () => {
  it("is TRIALING one millisecond before the boundary", () => {
    const s = resolveEffectiveState(trial(), new Date(TRIAL_END.getTime() - 1), UTC);
    expect(s.status).toBe("TRIALING");
    expect(s.suspended).toBe(false);
    expect(s.needsMaterialization).toBe(false);
    expect(iso(s.periodEnd)).toBe(iso(TRIAL_END));
    expect(s.reason).toBe("within_period");
  });

  it("is TRIALING throughout the trial, from its very first instant", () => {
    expect(resolveEffectiveState(trial(), TRIAL_START, UTC).status).toBe("TRIALING");
    expect(resolveEffectiveState(trial(), new Date("2026-08-22T13:00:00Z"), UTC).status).toBe("TRIALING");
  });

  it("becomes ACTIVE at EXACTLY the boundary when a plan is scheduled", () => {
    const s = resolveEffectiveState(trial({ scheduledPlanId: "plan_1" }), TRIAL_END, UTC);
    expect(s.status).toBe("ACTIVE");
    expect(s.suspended).toBe(false);
    expect(s.trialConverted).toBe(true);
    expect(s.reason).toBe("trial_converted");
    // Zero gap: the paid period opens on the trial's closing instant.
    expect(iso(s.periodStart)).toBe(iso(TRIAL_END));
  });

  it("expires at EXACTLY the boundary when nothing is scheduled", () => {
    const s = resolveEffectiveState(trial(), TRIAL_END, UTC);
    expect(s.status).toBe("EXPIRED");
    expect(s.suspended).toBe(true);
    expect(s.reason).toBe("trial_lapsed");
    // No cron ran — the customer is suspended from the boundary itself, not
    // up to 30 minutes later.
    expect(s.needsMaterialization).toBe(true);
  });

  it("one millisecond after the boundary behaves identically to the boundary", () => {
    const justAfter = new Date(TRIAL_END.getTime() + 1);
    expect(resolveEffectiveState(trial({ scheduledPlanId: "p" }), justAfter, UTC).status).toBe("ACTIVE");
    expect(resolveEffectiveState(trial(), justAfter, UTC).status).toBe("EXPIRED");
  });
});

describe("trial → paid — zero gap, correct anchor", () => {
  it("paid period is [trialEnd, trialEnd + 1 anchored month)", () => {
    const s = resolveEffectiveState(trial({ scheduledPlanId: "plan_1" }), TRIAL_END, UTC);
    expect(iso(s.periodStart)).toBe("2026-08-29T00:00:00.000Z");
    expect(iso(s.periodEnd)).toBe("2026-09-29T00:00:00.000Z");
    // The spec's example, displayed inclusively: 29 Aug → 28 Sep.
    expect(new Date(s.periodEnd!.getTime() - 1).toISOString().slice(0, 10)).toBe("2026-09-28");
  });

  it("the paid anchor is the trial-end day, not the trial-start day", () => {
    const s = resolveEffectiveState(trial({ scheduledPlanId: "plan_1" }), TRIAL_END, UTC);
    expect(s.anchorDay).toBe(29); // trial started on the 15th
  });

  it("the second paid period is 29 Sep → 28 Oct, still with no gap", () => {
    const later = new Date("2026-10-02T00:00:00Z");
    const s = resolveEffectiveState(trial({ scheduledPlanId: "plan_1" }), later, UTC);
    expect(iso(s.periodStart)).toBe("2026-09-29T00:00:00.000Z");
    expect(iso(s.periodEnd)).toBe("2026-10-29T00:00:00.000Z");
    expect(new Date(s.periodEnd!.getTime() - 1).toISOString().slice(0, 10)).toBe("2026-10-28");
  });

  it("there is no instant between trial and paid that is unserved", () => {
    const sub = trial({ scheduledPlanId: "plan_1" });
    for (const offsetMs of [-2, -1, 0, 1, 2, 60_000]) {
      const s = resolveEffectiveState(sub, new Date(TRIAL_END.getTime() + offsetMs), UTC);
      expect(s.suspended).toBe(false);
      expect(["TRIALING", "ACTIVE"]).toContain(s.status);
    }
  });

  it("the trial period and the paid period share one boundary instant", () => {
    const sub = trial({ scheduledPlanId: "plan_1" });
    const during = resolveEffectiveState(sub, new Date("2026-08-20T00:00:00Z"), UTC);
    const after = resolveEffectiveState(sub, TRIAL_END, UTC);
    expect(iso(during.periodEnd)).toBe(iso(after.periodStart));
  });

  it("paidPeriodAfterTrial agrees with the resolver", () => {
    const { period, anchorDay } = paidPeriodAfterTrial(TRIAL_END, UTC);
    const s = resolveEffectiveState(trial({ scheduledPlanId: "plan_1" }), TRIAL_END, UTC);
    expect(iso(period.periodStart)).toBe(iso(s.periodStart));
    expect(iso(period.periodEnd)).toBe(iso(s.periodEnd));
    expect(anchorDay).toBe(s.anchorDay);
  });

  it("converts correctly in the billing timezone, not UTC", () => {
    // 29 Aug 00:00 IST.
    const istTrialEnd = new Date("2026-08-28T18:30:00Z");
    const s = resolveEffectiveState(
      trial({ endDate: istTrialEnd, scheduledPlanId: "plan_1" }),
      istTrialEnd,
      IST,
    );
    expect(s.status).toBe("ACTIVE");
    expect(s.anchorDay).toBe(29);
    expect(iso(s.periodEnd)).toBe("2026-09-28T18:30:00.000Z"); // 29 Sep 00:00 IST
  });
});

describe("paid renewal — without any cron run", () => {
  it("stays ACTIVE with the rolled period once the stored period has lapsed", () => {
    const s = resolveEffectiveState(paid(), new Date("2026-09-20T00:00:00Z"), UTC);
    expect(s.status).toBe("ACTIVE");
    expect(s.suspended).toBe(false);
    expect(iso(s.periodStart)).toBe("2026-09-15T00:00:00.000Z");
    expect(iso(s.periodEnd)).toBe("2026-10-15T00:00:00.000Z");
    expect(s.needsMaterialization).toBe(true);
    expect(s.reason).toBe("renewed");
  });

  it("catches up across several missed periods and stays served throughout", () => {
    const s = resolveEffectiveState(paid(), new Date("2027-01-20T00:00:00Z"), UTC);
    expect(s.status).toBe("ACTIVE");
    expect(iso(s.periodStart)).toBe("2027-01-15T00:00:00.000Z");
    expect(iso(s.periodEnd)).toBe("2027-02-15T00:00:00.000Z");
  });

  it("keeps PAST_DUE in the grace window rather than promoting it to ACTIVE", () => {
    const s = resolveEffectiveState(paid({ status: "PAST_DUE" }), new Date("2026-09-20T00:00:00Z"), UTC);
    expect(s.status).toBe("PAST_DUE");
    expect(s.pastDue).toBe(true);
    expect(s.suspended).toBe(false); // grace: still served
  });

  it("EXPIRES a subscription that was cancelled at period end", () => {
    const s = resolveEffectiveState(paid({ autoRenew: false }), new Date("2026-09-20T00:00:00Z"), UTC);
    expect(s.status).toBe("EXPIRED");
    expect(s.suspended).toBe(true);
    expect(s.reason).toBe("not_renewing");
  });

  it("preserves a stored anchor of 31 across February", () => {
    const sub = paid({
      startDate: new Date("2026-01-31T00:00:00Z"),
      endDate: new Date("2026-02-28T00:00:00Z"),
      billingAnchorDay: 31,
    });
    const s = resolveEffectiveState(sub, new Date("2026-03-15T00:00:00Z"), UTC);
    // Feb period is 28 Feb → 31 Mar, and the anchor is still 31.
    expect(iso(s.periodStart)).toBe("2026-02-28T00:00:00.000Z");
    expect(iso(s.periodEnd)).toBe("2026-03-31T00:00:00.000Z");
    expect(s.anchorDay).toBe(31);
  });

  it("derives the anchor from the period END on a legacy row with none stored", () => {
    const sub = paid({ billingAnchorDay: null });
    const s = resolveEffectiveState(sub, new Date("2026-09-20T00:00:00Z"), UTC);
    expect(s.anchorDay).toBe(15);
    expect(iso(s.periodStart)).toBe("2026-09-15T00:00:00.000Z");
  });

  it("keeps a legacy PARTIAL first period on the schedule it already has", () => {
    // The pre-migration shape the old model produced: assigned mid-month, with
    // the period truncated at the 1st. Its next period must start on the 1st —
    // deriving the anchor from `startDate` would say the 15th and silently move
    // this customer's renewal date, which the migration must never do.
    const legacyFirstPeriod = paid({
      startDate: new Date("2026-08-15T10:37:02.418Z"),
      endDate: new Date("2026-09-01T00:00:00Z"),
      billingAnchorDay: null,
    });

    const s = resolveEffectiveState(legacyFirstPeriod, new Date("2026-09-02T00:00:00Z"), UTC);

    expect(s.anchorDay).toBe(1);
    expect(iso(s.periodStart)).toBe("2026-09-01T00:00:00.000Z");
    expect(iso(s.periodEnd)).toBe("2026-10-01T00:00:00.000Z");
  });

  it("reports the stored partial period untouched while it is still running", () => {
    const legacyFirstPeriod = paid({
      startDate: new Date("2026-08-15T10:37:02.418Z"),
      endDate: new Date("2026-09-01T00:00:00Z"),
      billingAnchorDay: null,
    });

    const s = resolveEffectiveState(legacyFirstPeriod, new Date("2026-08-20T00:00:00Z"), UTC);

    expect(iso(s.periodStart)).toBe("2026-08-15T10:37:02.418Z");
    expect(iso(s.periodEnd)).toBe("2026-09-01T00:00:00.000Z");
    expect(s.needsMaterialization).toBe(false);
  });
});

describe("terminal states are never resurrected", () => {
  it("EXPIRED stays EXPIRED even with autoRenew and a future-looking clock", () => {
    const s = resolveEffectiveState(
      paid({ status: "EXPIRED", autoRenew: true }),
      new Date("2027-05-01T00:00:00Z"),
      UTC,
    );
    expect(s.status).toBe("EXPIRED");
    expect(s.suspended).toBe(true);
    expect(s.needsMaterialization).toBe(false);
    expect(s.nextBoundary).toBeNull();
    expect(s.reason).toBe("terminal");
  });

  it("CANCELED stays CANCELED even with a scheduled plan", () => {
    const s = resolveEffectiveState(
      trial({ status: "CANCELED", scheduledPlanId: "plan_1" }),
      new Date("2027-05-01T00:00:00Z"),
      UTC,
    );
    expect(s.status).toBe("CANCELED");
    expect(s.suspended).toBe(true);
    expect(s.trialConverted).toBe(false);
  });
});

describe("legacy and edge rows", () => {
  it("an open-ended row (null endDate) is served unchanged", () => {
    const s = resolveEffectiveState(paid({ endDate: null }), new Date("2030-01-01T00:00:00Z"), UTC);
    expect(s.status).toBe("ACTIVE");
    expect(s.suspended).toBe(false);
    expect(s.periodEnd).toBeNull();
    expect(s.reason).toBe("open_ended");
    expect(s.needsMaterialization).toBe(false);
  });

  it("existing calendar-aligned subscriptions keep renewing on the 1st", () => {
    const calendarAligned = paid({
      startDate: new Date("2026-08-01T00:00:00Z"),
      endDate: new Date("2026-09-01T00:00:00Z"),
      billingAnchorDay: null, // pre-migration row
    });
    const s = resolveEffectiveState(calendarAligned, new Date("2026-09-10T00:00:00Z"), UTC);
    expect(s.anchorDay).toBe(1);
    expect(iso(s.periodStart)).toBe("2026-09-01T00:00:00.000Z");
    expect(iso(s.periodEnd)).toBe("2026-10-01T00:00:00.000Z");
  });

  it("a corrupt anchor value falls back to a safe anchor rather than throwing", () => {
    const s = resolveEffectiveState(paid({ billingAnchorDay: 99 }), new Date("2026-09-20T00:00:00Z"), UTC);
    expect(s.anchorDay).toBe(31);
    expect(s.status).toBe("ACTIVE");
  });
});

describe("boundedCacheTtlSeconds — no cached state survives a boundary", () => {
  it("caps at the full TTL when the boundary is far away", () => {
    const s = resolveEffectiveState(trial(), TRIAL_START, UTC);
    expect(boundedCacheTtlSeconds(s, TRIAL_START, 300)).toBe(300);
  });

  it("clamps to the seconds remaining when the boundary is near", () => {
    const now = new Date(TRIAL_END.getTime() - 42_000);
    const s = resolveEffectiveState(trial(), now, UTC);
    expect(boundedCacheTtlSeconds(s, now, 300)).toBe(42);
  });

  it("never returns 0 — that means 'no expiry' in Redis", () => {
    const now = new Date(TRIAL_END.getTime() - 1);
    const s = resolveEffectiveState(trial(), now, UTC);
    expect(boundedCacheTtlSeconds(s, now, 300)).toBe(1);
  });

  it("uses the full TTL for a terminal state, which cannot change with time", () => {
    const s = resolveEffectiveState(paid({ status: "EXPIRED" }), new Date(), UTC);
    expect(boundedCacheTtlSeconds(s, new Date(), 300)).toBe(300);
  });

  it("a value cached right up to the boundary still resolves correctly after it", () => {
    // The cached ROW is resolved against a live clock, so even a stale cache
    // cannot serve a stale verdict.
    const sub = trial({ scheduledPlanId: "plan_1" });
    const cachedAt = new Date(TRIAL_END.getTime() - 1000);
    expect(resolveEffectiveState(sub, cachedAt, UTC).status).toBe("TRIALING");
    expect(resolveEffectiveState(sub, TRIAL_END, UTC).status).toBe("ACTIVE");
  });
});
