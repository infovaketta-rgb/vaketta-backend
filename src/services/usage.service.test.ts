/**
 * Metering and quota enforcement.
 *
 * Locks in:
 *  - `isSuspended` (entitlement) and `isOverQuota` (consumption) are SEPARATE —
 *    they used to be one boolean, so an unpaid account logged "conversation
 *    quota exceeded" and sent every investigation the wrong way;
 *  - `aiReplyLimit` is actually enforced — it was stored, snapshotted and
 *    displayed but never once compared against `aiRepliesUsed`, so any plan
 *    could burn unbounded LLM spend;
 *  - PAST_DUE is served (grace window), EXPIRED/CANCELED are not;
 *  - checks fail OPEN on infrastructure errors — never silence a paying hotel's
 *    bot because Redis or Postgres blipped;
 *  - usage buckets follow the BILLING PERIOD, not the calendar month, so a hotel
 *    anchored on the 15th does not have its allowance reset on the 1st.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma, SubscriptionStatus } from "@prisma/client";

let usageRow: { conversationsUsed: number; aiRepliesUsed: number } | null;
let currentSub: Record<string, any> | null;
let statusValue: SubscriptionStatus | null;
let statusThrows: boolean;
let subThrows: boolean;
let effective: Record<string, any> | null;
let effectiveThrows: boolean;

/** Every upsert/findUnique the service issues, so we can assert the bucket key. */
let upserts: any[];
let lastFindUnique: any;
/** Simulates the legacy (hotelId, month) unique index still being present. */
let upsertFailsOnce: "month" | "always-month" | "other" | null;

const monthConflict = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: ["hotelId", "month"] },
  });

const db = {
  usageRecord: {
    findUnique: async (args: any) => {
      lastFindUnique = args;
      return usageRow;
    },
    upsert: async (args: any) => {
      upserts.push(args);
      if (upsertFailsOnce === "other") throw new Error("connection lost");
      if (upsertFailsOnce === "always-month") throw monthConflict();
      if (upsertFailsOnce === "month" && upserts.length === 1) throw monthConflict();
      return {};
    },
    findMany: async () => [],
    aggregate: async () => ({ _sum: { conversationsUsed: 0, aiRepliesUsed: 0 } }),
    groupBy: async () => [],
  },
};

vi.mock("../db/connect", () => ({
  default: new Proxy({} as any, { get: (_t, p) => (db as any)[p] }),
}));

vi.mock("./billing.service", () => ({
  getBillingConfig: async () => ({ timezone: "UTC", gracePeriodDays: 7 }),
  getSubscriptionStatus: async () => {
    if (statusThrows) throw new Error("redis down");
    return statusValue;
  },
  getCurrentSubscription: async () => {
    if (subThrows) throw new Error("db down");
    return currentSub;
  },
  getEffectiveSubscription: async () => {
    if (effectiveThrows) throw new Error("db down");
    return effective;
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  isSuspended,
  isOverQuota,
  isAIReplyOverQuota,
  currentMonth,
  resolveUsagePeriod,
  incrementConversationUsage,
  incrementAIUsage,
  getCurrentUsage,
} from "./usage.service";

const SUB = {
  conversationLimit: 1000,
  aiReplyLimit: 500,
  extraConversationCharge: 50,
  extraAiReplyCharge: 200,
};

const TERMS = {
  planName: "Starter",
  currency: "INR",
  price: 249900,
  conversationLimit: 1000,
  aiReplyLimit: 500,
  extraConversationCharge: 50,
  extraAiReplyCharge: 200,
};

/** A hotel anchored on the 15th, currently in 15 Aug → 15 Sep. */
const ANCHORED_15 = {
  status: SubscriptionStatus.ACTIVE,
  periodStart: new Date("2026-08-15T00:00:00Z"),
  periodEnd: new Date("2026-09-15T00:00:00Z"),
  anchorDay: 15,
  suspended: false,
  trialConverted: false,
  terms: { ...TERMS },
};

beforeEach(() => {
  usageRow = { conversationsUsed: 0, aiRepliesUsed: 0 };
  currentSub = { ...SUB };
  statusValue = SubscriptionStatus.ACTIVE;
  statusThrows = false;
  subThrows = false;
  effective = { ...ANCHORED_15 };
  effectiveThrows = false;
  upserts = [];
  lastFindUnique = null;
  upsertFailsOnce = null;
});

describe("isSuspended — entitlement, not consumption", () => {
  it.each([
    [SubscriptionStatus.EXPIRED, true],
    [SubscriptionStatus.CANCELED, true],
    [SubscriptionStatus.ACTIVE, false],
    [SubscriptionStatus.TRIALING, false],
    // The grace window: an overdue invoice must not cut service instantly.
    [SubscriptionStatus.PAST_DUE, false],
  ])("%s → %s", async (status, expected) => {
    statusValue = status;
    expect(await isSuspended("h1")).toBe(expected);
  });

  it("is false for an unknown hotel — not this function's call to make", async () => {
    statusValue = null;
    expect(await isSuspended("h1")).toBe(false);
  });

  it("fails OPEN when the status cannot be read", async () => {
    statusThrows = true;
    expect(await isSuspended("h1")).toBe(false);
  });

  it("does NOT consider usage — a hotel over quota is still entitled", async () => {
    usageRow = { conversationsUsed: 999_999, aiRepliesUsed: 999_999 };
    expect(await isSuspended("h1")).toBe(false);
  });
});

describe("isOverQuota — conversations", () => {
  it("is false below the limit and true at or above it", async () => {
    usageRow = { conversationsUsed: 999, aiRepliesUsed: 0 };
    expect(await isOverQuota("h1")).toBe(false);

    usageRow = { conversationsUsed: 1000, aiRepliesUsed: 0 };
    expect(await isOverQuota("h1")).toBe(true);
  });

  it("treats limit 0 as unlimited", async () => {
    effective = { ...ANCHORED_15, terms: { ...TERMS, conversationLimit: 0 } };
    usageRow = { conversationsUsed: 500_000, aiRepliesUsed: 0 };
    expect(await isOverQuota("h1")).toBe(false);
  });

  it("is false with no subscription — the legacy free-forever state", async () => {
    effective = { ...ANCHORED_15, terms: null };
    usageRow = { conversationsUsed: 500_000, aiRepliesUsed: 0 };
    expect(await isOverQuota("h1")).toBe(false);
  });

  it("fails OPEN on a DB error", async () => {
    effectiveThrows = true;
    expect(await isOverQuota("h1")).toBe(false);
  });

  it("does not consider AI usage", async () => {
    usageRow = { conversationsUsed: 10, aiRepliesUsed: 999_999 };
    expect(await isOverQuota("h1")).toBe(false);
  });
});

describe("isAIReplyOverQuota — the limit that was never enforced", () => {
  it("is true once aiRepliesUsed reaches aiReplyLimit", async () => {
    usageRow = { conversationsUsed: 0, aiRepliesUsed: 499 };
    expect(await isAIReplyOverQuota("h1")).toBe(false);

    usageRow = { conversationsUsed: 0, aiRepliesUsed: 500 };
    expect(await isAIReplyOverQuota("h1")).toBe(true);
  });

  it("keeps burning LLM spend only when the plan says unlimited", async () => {
    effective = { ...ANCHORED_15, terms: { ...TERMS, aiReplyLimit: 0 } };
    usageRow = { conversationsUsed: 0, aiRepliesUsed: 1_000_000 };
    expect(await isAIReplyOverQuota("h1")).toBe(false);
  });

  it("is independent of the conversation meter", async () => {
    usageRow = { conversationsUsed: 999_999, aiRepliesUsed: 10 };
    expect(await isAIReplyOverQuota("h1")).toBe(false);
  });

  it("fails OPEN on a DB error", async () => {
    effectiveThrows = true;
    expect(await isAIReplyOverQuota("h1")).toBe(false);
  });

  it("survives a corrupt negative limit instead of silencing the bot forever", async () => {
    // A negative limit used to make `usage >= -5` permanently true. The
    // controller now rejects these, but the read path must be safe regardless.
    effective = { ...ANCHORED_15, terms: { ...TERMS, aiReplyLimit: -5 } };
    usageRow = { conversationsUsed: 0, aiRepliesUsed: 0 };
    expect(await isAIReplyOverQuota("h1")).toBe(false);
  });
});

describe("quota terms track the CONVERTED plan, not the trial", () => {
  // Between a trial's boundary and the cron materialising the conversion, the
  // live DB row is still the trial. Reading limits from there while reading
  // usage from the (fresh, paid) period applied trial limits to a paid counter.
  const CONVERTED = {
    ...ANCHORED_15,
    periodStart: new Date("2026-08-29T00:00:00Z"),
    periodEnd: new Date("2026-09-29T00:00:00Z"),
    anchorDay: 29,
    trialConverted: true,
    // What getEffectiveSubscription reports post-boundary: the scheduled plan's
    // terms, not the trial's 500/200.
    terms: { ...TERMS, planName: "Growth", conversationLimit: 2000, aiReplyLimit: 1000 },
  };

  it("applies the paid plan's limits immediately at the boundary", async () => {
    effective = { ...CONVERTED };
    // Over the TRIAL's 500 allowance but well inside the paid plan's 2000.
    usageRow = { conversationsUsed: 900, aiRepliesUsed: 0 };

    expect(await isOverQuota("h1")).toBe(false);
  });

  it("still enforces the paid plan's own limit", async () => {
    effective = { ...CONVERTED };
    usageRow = { conversationsUsed: 2000, aiRepliesUsed: 0 };

    expect(await isOverQuota("h1")).toBe(true);
  });

  it("measures against the paid period's bucket, not the trial's", async () => {
    effective = { ...CONVERTED };
    await incrementConversationUsage("h1");

    expect(upserts[0].where.hotelId_periodStart.periodStart).toEqual(new Date("2026-08-29T00:00:00Z"));
  });

  it("limits and usage are read for the same instant", async () => {
    // Both sides of the comparison come from one resolver call, so they cannot
    // describe different periods.
    effective = { ...CONVERTED };
    usageRow = null;
    const usage = await getCurrentUsage("h1", new Date("2026-09-01T00:00:00Z"));
    expect((usage as any).periodStart).toEqual(CONVERTED.periodStart);
  });
});

describe("currentMonth", () => {
  it("uses the platform billing timezone rather than server-local time", async () => {
    const key = await currentMonth(new Date("2026-06-30T20:00:00Z"));
    expect(key).toBe("2026-06"); // mocked config is UTC
    expect(key).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("resolveUsagePeriod — buckets follow the billing period", () => {
  it("uses the hotel's effective period, not the calendar month", async () => {
    const period = await resolveUsagePeriod("h1", new Date("2026-08-20T12:00:00Z"));

    expect(period.periodStart.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(period.periodEnd.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    // The calendar label is retained for platform analytics.
    expect(period.month).toBe("2026-08");
  });

  it("does NOT roll over on the 1st of the calendar month", async () => {
    const midAugust = await resolveUsagePeriod("h1", new Date("2026-08-20T00:00:00Z"));
    const earlySeptember = await resolveUsagePeriod("h1", new Date("2026-09-02T00:00:00Z"));

    // Both fall inside 15 Aug → 15 Sep, so they must be the SAME bucket.
    expect(earlySeptember.periodStart.toISOString()).toBe(midAugust.periodStart.toISOString());
  });

  it("rolls over on the billing anchor", async () => {
    const before = await resolveUsagePeriod("h1", new Date("2026-09-14T23:59:59Z"));
    effective = {
      ...ANCHORED_15,
      periodStart: new Date("2026-09-15T00:00:00Z"),
      periodEnd: new Date("2026-10-15T00:00:00Z"),
    };
    const after = await resolveUsagePeriod("h1", new Date("2026-09-15T00:00:00Z"));

    expect(before.periodStart.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(after.periodStart.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    // Adjacent buckets share a boundary: no usage can fall between them.
    expect(before.periodEnd.toISOString()).toBe(after.periodStart.toISOString());
  });

  it("falls back to the calendar month for a hotel with no subscription", async () => {
    effective = null;
    const period = await resolveUsagePeriod("h1", new Date("2026-08-20T12:00:00Z"));

    expect(period.periodStart.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(period.periodEnd.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(period.month).toBe("2026-08");
  });

  it("falls back to the calendar month rather than throwing when billing is unreadable", async () => {
    effectiveThrows = true;
    const period = await resolveUsagePeriod("h1", new Date("2026-08-20T12:00:00Z"));
    expect(period.periodStart.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("uses the open-ended fallback for a legacy row with no period end", async () => {
    effective = { ...ANCHORED_15, periodEnd: null };
    const period = await resolveUsagePeriod("h1", new Date("2026-08-20T12:00:00Z"));
    expect(period.periodStart.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("metering writes into the billing-period bucket", () => {
  it("conversation increments are keyed by periodStart", async () => {
    await incrementConversationUsage("h1");

    expect(upserts).toHaveLength(1);
    expect(upserts[0].where.hotelId_periodStart).toEqual({
      hotelId: "h1",
      periodStart: new Date("2026-08-15T00:00:00Z"),
    });
    expect(upserts[0].update).toEqual({ conversationsUsed: { increment: 1 } });
    // The calendar label is still written, for platform analytics.
    expect(upserts[0].create.month).toBe("2026-08");
    expect(upserts[0].create.periodEnd).toEqual(new Date("2026-09-15T00:00:00Z"));
  });

  it("AI increments share the same bucket key", async () => {
    await incrementAIUsage("h1");

    expect(upserts[0].where.hotelId_periodStart.periodStart).toEqual(new Date("2026-08-15T00:00:00Z"));
    expect(upserts[0].update).toEqual({ aiRepliesUsed: { increment: 1 } });
  });

  it("relabels the month when the LEGACY (hotelId, month) index blocks the insert", async () => {
    // The expand→contract window: new code, old index still present. A trial
    // converting mid-month gives two periods starting in the same month.
    effective = {
      ...ANCHORED_15,
      periodStart: new Date("2026-08-29T00:00:00Z"),
      periodEnd: new Date("2026-09-29T00:00:00Z"),
    };
    upsertFailsOnce = "month";

    await incrementConversationUsage("h1");

    expect(upserts).toHaveLength(2);
    expect(upserts[0].create.month).toBe("2026-08"); // collides with the trial row
    // Retried with the month the period ENDS in — a distinct, valid label, and
    // crucially a SEPARATE row, so trial usage is not merged into paid usage.
    expect(upserts[1].create.month).toBe("2026-09");
    expect(upserts[1].where.hotelId_periodStart.periodStart).toEqual(new Date("2026-08-29T00:00:00Z"));
  });

  it("drops the metering event rather than breaking the message pipeline", async () => {
    upsertFailsOnce = "always-month";
    await expect(incrementConversationUsage("h1")).resolves.toBeUndefined();
  });

  it("rethrows a genuine database error instead of silently swallowing it", async () => {
    upsertFailsOnce = "other";
    await expect(incrementConversationUsage("h1")).rejects.toThrow("connection lost");
  });

  it("a converted trial meters into the PAID period, not the trial's bucket", async () => {
    // Trial ran 15 Aug → 29 Aug; the paid period began at the boundary.
    effective = {
      ...ANCHORED_15,
      periodStart: new Date("2026-08-29T00:00:00Z"),
      periodEnd: new Date("2026-09-29T00:00:00Z"),
      anchorDay: 29,
    };

    await incrementConversationUsage("h1");

    expect(upserts[0].where.hotelId_periodStart.periodStart).toEqual(new Date("2026-08-29T00:00:00Z"));
    // Same calendar month as the trial, but a DIFFERENT bucket — which is why
    // the `month` column can no longer be the identity.
    expect(upserts[0].create.month).toBe("2026-08");
  });

  it("getCurrentUsage reads the period bucket and reports its bounds when empty", async () => {
    usageRow = null;
    const usage = await getCurrentUsage("h1", new Date("2026-08-20T00:00:00Z"));

    expect(lastFindUnique.where.hotelId_periodStart.periodStart).toEqual(new Date("2026-08-15T00:00:00Z"));
    expect(usage.conversationsUsed).toBe(0);
    expect((usage as any).periodStart).toEqual(new Date("2026-08-15T00:00:00Z"));
    expect((usage as any).periodEnd).toEqual(new Date("2026-09-15T00:00:00Z"));
  });
});
