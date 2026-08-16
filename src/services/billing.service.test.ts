/**
 * Regression tests for the subscription lifecycle.
 *
 * Locks in the behaviours whose absence was costing money:
 *  - periods start at signup and the partial first period is PRORATED (a hotel
 *    signing up on the 28th used to get 3 days and a full month's bill);
 *  - assign/trial are transactional and cancel whatever was live first, so the
 *    "one live subscription per hotel" invariant holds;
 *  - trials never auto-renew;
 *  - renewal issues an invoice and rolls the period, and re-running the cron
 *    does NOT double-invoice;
 *  - expiry closes the subscription row, emits, and audits — none of which the
 *    old three-line `updateMany` did;
 *  - MRR is per-currency and read from the snapshot, not the live plan.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// ── In-memory store ──────────────────────────────────────────────────────────

type Row = Record<string, any>;

let hotels: Map<string, Row>;
let subscriptions: Row[];
let invoices: Row[];
let usageRecords: Row[];
let plans: Map<string, Row>;
let auditLogs: Row[];
let seq: number;

const LIVE = ["TRIALING", "ACTIVE", "PAST_DUE"];

function matchStatus(value: string, filter: any): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "string") return value === filter;
  if (filter.in) return filter.in.includes(value);
  return true;
}

function matchDate(value: Date | null, filter: any): boolean {
  if (filter === undefined) return true;
  if (filter.not === null && value === null) return false;
  if (filter.lt && !(value && value < filter.lt)) return false;
  if (filter.lte && !(value && value <= filter.lte)) return false;
  if (filter.gt && !(value && value > filter.gt)) return false;
  if (filter.gte && !(value && value >= filter.gte)) return false;
  return true;
}

const db = {
  $transaction: async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)),
  // `issueInvoice` takes an advisory lock via $executeRaw. This stub existing
  // only as $queryRaw is how the production P2010 slipped through: the real
  // call returns `void`, which $queryRaw cannot deserialize, but a mock that
  // answers `[]` to anything hides that entirely. Both are stubbed now so the
  // shape of the call is at least pinned to the one the service really makes.
  $queryRaw: async () => [],
  $executeRaw: async () => 0,

  hotel: {
    findUnique: async ({ where }: any) => hotels.get(where.id) ?? null,
    findMany: async ({ where = {} }: any) =>
      [...hotels.values()].filter(
        (h) =>
          matchStatus(h.subscriptionStatus, where.subscriptionStatus) &&
          matchDate(h.billingEndDate ?? null, where.billingEndDate),
      ),
    update: async ({ where, data }: any) => {
      const h = hotels.get(where.id)!;
      Object.assign(h, data);
      return h;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const h of hotels.values()) {
        if (where.id && h.id !== where.id) continue;
        if (!matchStatus(h.subscriptionStatus, where.subscriptionStatus)) continue;
        Object.assign(h, data);
        count++;
      }
      return { count };
    },
    count: async ({ where = {} }: any) =>
      [...hotels.values()].filter((h) => matchStatus(h.subscriptionStatus, where.subscriptionStatus)).length,
    groupBy: async () => [],
  },

  subscription: {
    create: async ({ data }: any) => {
      const row = { id: `sub_${++seq}`, createdAt: new Date(), canceledAt: null, ...data };
      subscriptions.push(row);
      return row;
    },
    findFirst: async ({ where, orderBy }: any) => {
      let rows = subscriptions.filter(
        (s) =>
          (!where.id || s.id === where.id) &&
          (!where.hotelId || s.hotelId === where.hotelId) &&
          matchStatus(s.status, where.status),
      );
      if (orderBy?.createdAt === "desc") rows = [...rows].reverse();
      return rows[0] ?? null;
    },
    findMany: async ({ where = {} }: any) =>
      subscriptions.filter(
        (s) =>
          (!where.hotelId || s.hotelId === where.hotelId) &&
          matchStatus(s.status, where.status) &&
          (where.autoRenew === undefined || s.autoRenew === where.autoRenew) &&
          // `{ not: null }` on scheduledPlanId — the trial-conversion sweep.
          (where.scheduledPlanId === undefined ||
            (where.scheduledPlanId?.not === null ? s.scheduledPlanId != null : true)) &&
          matchDate(s.endDate ?? null, where.endDate),
      ),
    update: async ({ where, data }: any) => {
      const row = subscriptions.find((s) => s.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const s of subscriptions) {
        if (where.hotelId && s.hotelId !== where.hotelId) continue;
        if (!matchStatus(s.status, where.status)) continue;
        Object.assign(s, data);
        count++;
      }
      return { count };
    },
    groupBy: async ({ where = {} }: any) => {
      const live = subscriptions.filter(
        (s) => matchStatus(s.status, where.status) && (!where.price?.gt || s.price > where.price.gt),
      );
      const byCurrency = new Map<string, { sum: number; count: number }>();
      for (const s of live) {
        const cur = byCurrency.get(s.currency) ?? { sum: 0, count: 0 };
        cur.sum += s.price;
        cur.count++;
        byCurrency.set(s.currency, cur);
      }
      return [...byCurrency.entries()].map(([currency, v]) => ({
        currency,
        _sum: { price: v.sum },
        _count: { _all: v.count },
      }));
    },
  },

  invoice: {
    create: async ({ data }: any) => {
      const dup = invoices.find(
        (i) => i.hotelId === data.hotelId && i.periodStart.getTime() === data.periodStart.getTime(),
      );
      // Mirrors the @@unique([hotelId, periodStart]) constraint — this is what
      // makes the renewal cron safe to re-run.
      if (dup) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        });
      }
      const row = { id: `inv_${++seq}`, ...data };
      invoices.push(row);
      return row;
    },
    findUnique: async ({ where }: any) => {
      if (where.hotelId_periodStart) {
        const { hotelId, periodStart } = where.hotelId_periodStart;
        return (
          invoices.find((i) => i.hotelId === hotelId && i.periodStart.getTime() === periodStart.getTime()) ?? null
        );
      }
      return invoices.find((i) => i.id === where.id) ?? null;
    },
    findFirst: async ({ where }: any) => {
      const prefix = where?.number?.startsWith;
      const rows = invoices.filter((i) => !prefix || String(i.number).startsWith(prefix));
      return [...rows].sort((a, b) => String(b.number).localeCompare(String(a.number)))[0] ?? null;
    },
    findMany: async () => invoices,
  },

  usageRecord: {
    // Buckets are keyed by the BILLING PERIOD's start, not a calendar month —
    // this is what stops a paid invoice reading trial-period usage.
    findUnique: async ({ where }: any) => {
      const { hotelId, periodStart } = where.hotelId_periodStart;
      return (
        usageRecords.find(
          (u) => u.hotelId === hotelId && u.periodStart?.getTime() === periodStart.getTime(),
        ) ?? null
      );
    },
  },

  plan: {
    findUnique: async ({ where }: any) => plans.get(where.id) ?? null,
    findUniqueOrThrow: async ({ where }: any) => {
      const p = plans.get(where.id);
      if (!p) throw new Error("Plan not found");
      return p;
    },
  },

  trialConfig: {
    upsert: async () => ({
      id: "global",
      durationDays: 14,
      conversationLimit: 500,
      aiReplyLimit: 200,
      currency: "INR",
      autoStartOnCreate: true,
      trialMessage: "trial",
    }),
  },

  auditLog: {
    create: async ({ data }: any) => {
      const row = { id: `aud_${++seq}`, createdAt: new Date(), ...data };
      auditLogs.push(row);
      return row;
    },
    findFirst: async () => null,
  },

  platformSettings: {
    findUnique: async () => ({ billingTimezone: "UTC", gracePeriodDays: 7 }),
  },
};

// `vi.mock` factories are hoisted above `const db`, so the factory must not
// evaluate `db` eagerly. The Proxy defers every lookup to call time, by which
// point the module body has run.
vi.mock("../db/connect", () => ({
  default: new Proxy({} as any, { get: (_t, prop) => (db as any)[prop] }),
}));

const redisStore = new Map<string, string>();
vi.mock("../queue/redis", () => ({
  redis: {
    get: async (k: string) => redisStore.get(k) ?? null,
    set: async (k: string, v: string) => {
      redisStore.set(k, v);
      return "OK";
    },
    del: async (k: string) => {
      redisStore.delete(k);
      return 1;
    },
  },
}));

const emitToAdmin = vi.fn();
vi.mock("../realtime/emit", () => ({ emitToAdmin: (...a: any[]) => emitToAdmin(...a), emitToHotel: vi.fn() }));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  assignPlanToHotel,
  schedulePlanAtTrialEnd,
  startTrial,
  convertDueTrials,
  renewDueSubscriptions,
  expireOverdueSubscriptions,
  getCurrentSubscription,
  getEffectiveSubscription,
  cancelSubscription,
  extendSubscription,
  getAdminBillingAnalytics,
} from "./billing.service";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PLAN_INR = {
  id: "plan_inr",
  name: "Starter",
  currency: "INR",
  country: "IN",
  priceMonthly: 249900, // ₹2,499.00
  conversationLimit: 2000,
  aiReplyLimit: 1000,
  extraConversationCharge: 50,
  extraAiReplyCharge: 200,
  isActive: true,
};

const PLAN_USD = { ...PLAN_INR, id: "plan_usd", name: "Growth", currency: "USD", priceMonthly: 4900 };

beforeEach(() => {
  hotels = new Map([
    ["h1", { id: "h1", name: "Hotel One", subscriptionStatus: "TRIALING", planId: null, billingStartDate: null, billingEndDate: null }],
    ["h2", { id: "h2", name: "Hotel Two", subscriptionStatus: "TRIALING", planId: null, billingStartDate: null, billingEndDate: null }],
  ]);
  subscriptions = [];
  invoices = [];
  usageRecords = [];
  auditLogs = [];
  plans = new Map([[PLAN_INR.id, { ...PLAN_INR }], [PLAN_USD.id, { ...PLAN_USD }]]);
  seq = 0;
  redisStore.clear();
  emitToAdmin.mockClear();
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("assignPlanToHotel — anchored periods", () => {
  it("anchors the period to the day it starts, NOT the calendar month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T10:00:00Z"));

    await assignPlanToHotel("h1", PLAN_INR.id);

    const hotel = hotels.get("h1")!;
    // Boundaries are clean local midnights, so nothing downstream depends on
    // what time of day an admin clicked the button.
    expect(hotel.billingStartDate.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    // THE REPORTED BUG: the old model produced 2026-09-01 here.
    expect(hotel.billingEndDate.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(hotel.billingEndDate.getTime()).toBeGreaterThan(Date.now());

    const sub = await getCurrentSubscription("h1");
    expect(sub!.billingAnchorDay).toBe(15);
  });

  it("charges a FULL month — an anchored first period is not partial", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-28T00:00:00Z"));

    await assignPlanToHotel("h1", PLAN_INR.id);

    expect(invoices).toHaveLength(1);
    // The old model gave 3 of 30 days here, because the period was truncated at
    // the 1st. It now runs 28 Jun → 28 Jul: a whole month, charged in full.
    expect(invoices[0]!.total).toBe(PLAN_INR.priceMonthly);
    expect(invoices[0]!.currency).toBe("INR");
    expect(invoices[0]!.periodStart.toISOString()).toBe("2026-06-28T00:00:00.000Z");
    expect(invoices[0]!.periodEnd.toISOString()).toBe("2026-07-28T00:00:00.000Z");
  });

  it("charges the full price when assigned on the 1st (unchanged behaviour)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));

    await assignPlanToHotel("h1", PLAN_INR.id);
    expect(invoices[0]!.subtotal).toBe(PLAN_INR.priceMonthly);
    expect(hotels.get("h1")!.billingEndDate.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("anchors on the 31st and survives February", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T09:00:00Z"));

    await assignPlanToHotel("h1", PLAN_INR.id);

    const sub = await getCurrentSubscription("h1");
    expect(sub!.billingAnchorDay).toBe(31);
    expect(sub!.endDate!.toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("snapshots the plan's terms so a later price edit does not change this period", async () => {
    await assignPlanToHotel("h1", PLAN_INR.id);
    const snapshot = await getCurrentSubscription("h1");

    plans.get(PLAN_INR.id)!.priceMonthly = 999900; // admin raises the price

    expect(snapshot!.price).toBe(249900);
    expect(snapshot!.planName).toBe("Starter");
  });

  it("cancels the previous subscription, leaving exactly one live row", async () => {
    await assignPlanToHotel("h1", PLAN_INR.id);
    await assignPlanToHotel("h1", PLAN_USD.id);

    const live = subscriptions.filter((s) => s.hotelId === "h1" && LIVE.includes(s.status));
    expect(live).toHaveLength(1);
    expect(live[0]!.currency).toBe("USD");

    const canceled = subscriptions.filter((s) => s.hotelId === "h1" && s.status === "CANCELED");
    expect(canceled).toHaveLength(1);
    expect(canceled[0]!.canceledAt).toBeInstanceOf(Date);
  });

  it("rejects an unknown hotel rather than creating an orphan subscription", async () => {
    await expect(assignPlanToHotel("nope", PLAN_INR.id)).rejects.toThrow("Hotel not found");
    expect(subscriptions).toHaveLength(0);
  });

  it("emits admin:subscription_changed and writes an audit row", async () => {
    await assignPlanToHotel("h1", PLAN_INR.id);

    expect(emitToAdmin).toHaveBeenCalledWith(
      "admin:subscription_changed",
      expect.objectContaining({ hotelId: "h1", status: "ACTIVE" }),
    );
    expect(auditLogs.some((a) => a.type === "plan.assigned")).toBe(true);
  });
});

describe("startTrial", () => {
  it("gives the hotel a real end date — the free-forever fix", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));

    await startTrial("h1");

    const hotel = hotels.get("h1")!;
    expect(hotel.subscriptionStatus).toBe("TRIALING");
    // NULL here is exactly what made the expiry cron's `billingEndDate < now`
    // never match, so these hotels were served free forever.
    expect(hotel.billingEndDate).not.toBeNull();
    expect(hotel.billingEndDate.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("never auto-renews — a free trial must not roll into a paid period", async () => {
    await startTrial("h1");
    const sub = await getCurrentSubscription("h1");
    expect(sub!.autoRenew).toBe(false);
    expect(sub!.price).toBe(0);
  });

  it("uses the configured currency, not a hardcoded USD", async () => {
    await startTrial("h1");
    const sub = await getCurrentSubscription("h1");
    expect(sub!.currency).toBe("INR");
  });

  it("applies per-call overrides over the global defaults", async () => {
    const result = await startTrial("h1", { durationDays: 30, conversationLimit: 100, aiReplyLimit: 0 });
    expect(result.durationDays).toBe(30);
    expect(result.conversationLimit).toBe(100);
    expect(result.aiReplyLimit).toBe(0);
  });

  it("issues no invoice for a free trial", async () => {
    await startTrial("h1");
    expect(invoices).toHaveLength(0);
  });

  it("uses clean midnight boundaries, whatever time of day it was started", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T17:42:13.918Z"));

    await startTrial("h1", { durationDays: 14 });
    const sub = await getCurrentSubscription("h1");

    // Half-open: 15 Aug 00:00 <= TRIAL < 29 Aug 00:00.
    expect(sub!.startDate.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(sub!.endDate!.toISOString()).toBe("2026-08-29T00:00:00.000Z");
  });
});

describe("trial → paid — scheduling and conversion", () => {
  async function trialingHotel(now = "2026-08-15T00:00:00Z") {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    await startTrial("h1", { durationDays: 14 }); // ends 2026-08-29T00:00Z
  }

  it("assigning a plan to a TRIALING hotel schedules it instead of truncating the trial", async () => {
    await trialingHotel();

    await assignPlanToHotel("h1", PLAN_INR.id);

    const sub = await getCurrentSubscription("h1");
    expect(sub!.status).toBe("TRIALING");
    expect(sub!.scheduledPlanId).toBe(PLAN_INR.id);
    // The trial keeps every day it was promised.
    expect(sub!.endDate!.toISOString()).toBe("2026-08-29T00:00:00.000Z");
    // Nothing is billed until the paid period actually starts.
    expect(invoices).toHaveLength(0);
    expect(auditLogs.some((a) => a.type === "plan.scheduled")).toBe(true);
  });

  it("startAt:'now' overrides the default and starts the paid period today", async () => {
    await trialingHotel();

    await assignPlanToHotel("h1", PLAN_INR.id, { startAt: "now" });

    const sub = await getCurrentSubscription("h1");
    expect(sub!.status).toBe("ACTIVE");
    expect(sub!.startDate.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(sub!.endDate!.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("rejects startAt:'trial_end' when the hotel has no live trial", async () => {
    await expect(assignPlanToHotel("h1", PLAN_INR.id, { startAt: "trial_end" }))
      .rejects.toThrow("Hotel is not on a trial");
  });

  it("converts at the boundary with ZERO gap between trial and paid", async () => {
    await trialingHotel();
    await assignPlanToHotel("h1", PLAN_INR.id);
    const trialEnd = (await getCurrentSubscription("h1"))!.endDate!;

    const converted = await convertDueTrials(new Date("2026-08-29T00:00:00Z"));
    expect(converted).toBe(1);

    const sub = await getCurrentSubscription("h1");
    expect(sub!.status).toBe("ACTIVE");
    expect(sub!.planId).toBe(PLAN_INR.id);
    // The paid period opens on the trial's exclusive end — one shared instant.
    expect(sub!.startDate.toISOString()).toBe(trialEnd.toISOString());
    expect(sub!.endDate!.toISOString()).toBe("2026-09-29T00:00:00.000Z");
    expect(sub!.billingAnchorDay).toBe(29);
    expect(sub!.autoRenew).toBe(true);
  });

  it("invoices the converted period in full, with no trial usage in it", async () => {
    await trialingHotel();
    await assignPlanToHotel("h1", PLAN_INR.id);
    // Heavy trial usage, in the TRIAL period's own bucket.
    usageRecords.push({
      hotelId: "h1",
      month: "2026-08",
      periodStart: new Date("2026-08-15T00:00:00Z"),
      periodEnd: new Date("2026-08-29T00:00:00Z"),
      conversationsUsed: 5000,
      aiRepliesUsed: 5000,
    });

    await convertDueTrials(new Date("2026-08-29T00:00:00Z"));

    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.periodStart.toISOString()).toBe("2026-08-29T00:00:00.000Z");
    expect(invoices[0]!.subtotal).toBe(PLAN_INR.priceMonthly);
    // Trial traffic is NEVER billed as paid overage.
    expect(invoices[0]!.overageTotal).toBe(0);
    expect(invoices[0]!.total).toBe(PLAN_INR.priceMonthly);
  });

  it("closes the trial row, leaving exactly one live subscription", async () => {
    await trialingHotel();
    await assignPlanToHotel("h1", PLAN_INR.id);
    await convertDueTrials(new Date("2026-08-29T00:00:00Z"));

    const live = subscriptions.filter((s) => s.hotelId === "h1" && LIVE.includes(s.status));
    expect(live).toHaveLength(1);
    expect(live[0]!.status).toBe("ACTIVE");
    expect(auditLogs.some((a) => a.type === "trial.converted")).toBe(true);
  });

  it("is idempotent — a second tick converts nothing more", async () => {
    await trialingHotel();
    await assignPlanToHotel("h1", PLAN_INR.id);
    const now = new Date("2026-08-29T00:00:00Z");

    expect(await convertDueTrials(now)).toBe(1);
    expect(await convertDueTrials(now)).toBe(0);
    expect(invoices).toHaveLength(1);
  });

  it("does not convert before the boundary", async () => {
    await trialingHotel();
    await assignPlanToHotel("h1", PLAN_INR.id);

    expect(await convertDueTrials(new Date("2026-08-28T23:59:59Z"))).toBe(0);
    expect((await getCurrentSubscription("h1"))!.status).toBe("TRIALING");
  });

  it("does not convert a trial with no scheduled plan", async () => {
    await trialingHotel();
    expect(await convertDueTrials(new Date("2026-08-29T00:00:00Z"))).toBe(0);
    expect(invoices).toHaveLength(0);
  });

  it("renewal then chains the converted subscription on its new anchor", async () => {
    await trialingHotel();
    await assignPlanToHotel("h1", PLAN_INR.id);
    await convertDueTrials(new Date("2026-08-29T00:00:00Z"));
    invoices.length = 0;

    await renewDueSubscriptions(new Date("2026-09-29T00:10:00Z"));

    const sub = await getCurrentSubscription("h1");
    // 29 Sep → 28 Oct displayed; 29 Sep → 29 Oct half-open.
    expect(sub!.startDate.toISOString()).toBe("2026-09-29T00:00:00.000Z");
    expect(sub!.endDate!.toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });
});

describe("renewDueSubscriptions", () => {
  /** A hotel anchored on the 15th whose first period has just closed. */
  async function setupDueSubscription() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00Z"));
    await assignPlanToHotel("h1", PLAN_INR.id);
    invoices.length = 0; // ignore the first-period invoice
    vi.setSystemTime(new Date("2026-07-15T00:30:00Z")); // period has ended
  }

  it("issues an invoice for the closed period and rolls to the next anchored one", async () => {
    await setupDueSubscription();

    const count = await renewDueSubscriptions(new Date("2026-07-15T00:30:00Z"));

    expect(count).toBe(1);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.subtotal).toBe(PLAN_INR.priceMonthly);
    expect(invoices[0]!.periodStart.toISOString()).toBe("2026-06-15T00:00:00.000Z");

    const sub = await getCurrentSubscription("h1");
    expect(sub!.startDate.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(sub!.endDate!.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(hotels.get("h1")!.billingEndDate.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("the closed period and the new one share a boundary — no gap, no overlap", async () => {
    await setupDueSubscription();
    await renewDueSubscriptions(new Date("2026-07-15T00:30:00Z"));

    const sub = await getCurrentSubscription("h1");
    expect(invoices[0]!.periodEnd.toISOString()).toBe(sub!.startDate.toISOString());
  });

  it("bills overage from the closed PERIOD's usage, keyed by periodStart", async () => {
    await setupDueSubscription();
    usageRecords.push({
      hotelId: "h1",
      month: "2026-06",
      periodStart: new Date("2026-06-15T00:00:00Z"),
      periodEnd: new Date("2026-07-15T00:00:00Z"),
      conversationsUsed: 2500,
      aiRepliesUsed: 1200,
    });

    await renewDueSubscriptions(new Date("2026-07-15T00:30:00Z"));

    // 500 extra conversations × 50 + 200 extra AI replies × 200
    expect(invoices[0]!.overageTotal).toBe(500 * 50 + 200 * 200);
    expect(invoices[0]!.total).toBe(PLAN_INR.priceMonthly + 500 * 50 + 200 * 200);
  });

  it("ignores usage from a DIFFERENT period that shares the calendar month", async () => {
    await setupDueSubscription();
    // A trial bucket that started earlier in the same month. The old
    // month-keyed lookup would have billed this traffic as paid overage.
    usageRecords.push({
      hotelId: "h1",
      month: "2026-06",
      periodStart: new Date("2026-06-01T00:00:00Z"),
      periodEnd: new Date("2026-06-15T00:00:00Z"),
      conversationsUsed: 9999,
      aiRepliesUsed: 9999,
    });

    await renewDueSubscriptions(new Date("2026-07-15T00:30:00Z"));

    expect(invoices[0]!.overageTotal).toBe(0);
    expect(invoices[0]!.total).toBe(PLAN_INR.priceMonthly);
  });

  it("is idempotent — a second tick does not double-invoice", async () => {
    await setupDueSubscription();
    const now = new Date("2026-07-15T00:30:00Z");

    await renewDueSubscriptions(now);
    const afterFirst = invoices.length;
    await renewDueSubscriptions(now);

    expect(invoices).toHaveLength(afterFirst);
    expect(invoices).toHaveLength(1);
  });

  it("catches up across several missed periods, invoicing each one exactly once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00Z"));
    await assignPlanToHotel("h1", PLAN_INR.id);
    invoices.length = 0;

    // The cron was down for three months.
    await renewDueSubscriptions(new Date("2026-09-20T00:00:00Z"));

    const periods = invoices.map((i) => i.periodStart.toISOString()).sort();
    expect(periods).toEqual([
      "2026-06-15T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
      "2026-08-15T00:00:00.000Z",
    ]);

    const sub = await getCurrentSubscription("h1");
    expect(sub!.startDate.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(sub!.endDate!.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("preserves an anchor of 31 while rolling through February", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T00:00:00Z"));
    await assignPlanToHotel("h1", PLAN_INR.id);
    invoices.length = 0;

    await renewDueSubscriptions(new Date("2026-04-05T00:00:00Z"));

    const sub = await getCurrentSubscription("h1");
    expect(sub!.billingAnchorDay).toBe(31);
    // 31 Jan → 28 Feb → 31 Mar → 30 Apr: the anchor never ratchets down to 28.
    expect(sub!.startDate.toISOString()).toBe("2026-03-31T00:00:00.000Z");
    expect(sub!.endDate!.toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("renews a legacy row with no stored anchor on its existing schedule", async () => {
    // Pre-migration shape: calendar-aligned, billingAnchorDay null.
    subscriptions.push({
      id: "legacy_1",
      hotelId: "h1",
      planId: PLAN_INR.id,
      status: "ACTIVE",
      planName: "Starter",
      currency: "INR",
      price: PLAN_INR.priceMonthly,
      conversationLimit: 2000,
      aiReplyLimit: 1000,
      extraConversationCharge: 50,
      extraAiReplyCharge: 200,
      startDate: new Date("2026-08-01T00:00:00Z"),
      endDate: new Date("2026-09-01T00:00:00Z"),
      billingAnchorDay: null,
      scheduledPlanId: null,
      autoRenew: true,
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });

    await renewDueSubscriptions(new Date("2026-09-02T00:00:00Z"));

    const sub = await getCurrentSubscription("h1");
    // Renewal date does NOT move: still the 1st.
    expect(sub!.startDate.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(sub!.endDate!.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(sub!.billingAnchorDay).toBe(1);
  });

  it("skips trials — autoRenew is false, so a trial never becomes a paid period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    await startTrial("h1");

    const count = await renewDueSubscriptions(new Date("2026-07-01T00:00:00Z"));

    expect(count).toBe(0);
    expect(invoices).toHaveLength(0);
  });

  it("leaves subscriptions whose period has not ended alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T00:00:00Z"));
    await assignPlanToHotel("h1", PLAN_INR.id);
    invoices.length = 0;

    const count = await renewDueSubscriptions(new Date("2026-06-20T00:00:00Z"));
    expect(count).toBe(0);
    expect(invoices).toHaveLength(0);
  });
});

describe("expireOverdueSubscriptions", () => {
  it("closes the subscription row too, not just the hotel status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    await startTrial("h1");

    const count = await expireOverdueSubscriptions(new Date("2026-07-01T00:00:00Z"));

    expect(count).toBe(1);
    expect(hotels.get("h1")!.subscriptionStatus).toBe("EXPIRED");
    // The old updateMany touched only Hotel, leaving the subscription dangling
    // as if it were still live.
    expect(subscriptions.find((s) => s.hotelId === "h1")!.status).toBe("EXPIRED");
  });

  it("emits and audits — the old cron did neither", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    await startTrial("h1");
    emitToAdmin.mockClear();

    await expireOverdueSubscriptions(new Date("2026-07-01T00:00:00Z"));

    expect(emitToAdmin).toHaveBeenCalledWith(
      "admin:subscription_changed",
      expect.objectContaining({ hotelId: "h1", status: "EXPIRED" }),
    );
    expect(auditLogs.some((a) => a.type === "subscription.expired")).toBe(true);
  });

  it("never touches a hotel with a NULL billingEndDate", async () => {
    // These are the legacy free-forever tenants. Suspending them from a cron
    // with no warning is deliberately not done — see billingBackfillReport.ts.
    const count = await expireOverdueSubscriptions(new Date("2026-07-01T00:00:00Z"));
    expect(count).toBe(0);
    expect(hotels.get("h1")!.subscriptionStatus).toBe("TRIALING");
  });

  it("is idempotent — a second run expires nothing more", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    await startTrial("h1");
    const now = new Date("2026-07-01T00:00:00Z");

    expect(await expireOverdueSubscriptions(now)).toBe(1);
    expect(await expireOverdueSubscriptions(now)).toBe(0);
  });

  it("NEVER expires a trial whose scheduled plan has taken over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    await startTrial("h1", { durationDays: 14 });
    await assignPlanToHotel("h1", PLAN_INR.id); // schedules at trial end

    // Trial end has passed and the conversion has NOT been materialised yet —
    // the exact window the old date-only check would have suspended.
    const count = await expireOverdueSubscriptions(new Date("2026-08-29T00:05:00Z"));

    expect(count).toBe(0);
    expect(hotels.get("h1")!.subscriptionStatus).toBe("TRIALING");
    expect((await getCurrentSubscription("h1"))!.status).toBe("TRIALING");
  });

  it("NEVER expires a paid subscription that is merely due for renewal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    await assignPlanToHotel("h1", PLAN_INR.id);

    const count = await expireOverdueSubscriptions(new Date("2026-09-16T00:00:00Z"));

    expect(count).toBe(0);
    expect((await getCurrentSubscription("h1"))!.status).toBe("ACTIVE");
  });

  it("DOES expire a subscription that was cancelled at period end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    await assignPlanToHotel("h1", PLAN_INR.id);
    await cancelSubscription("h1", false); // autoRenew off, serve to period end

    expect(await expireOverdueSubscriptions(new Date("2026-09-15T00:00:01Z"))).toBe(1);
    expect(hotels.get("h1")!.subscriptionStatus).toBe("EXPIRED");
  });
});

describe("getEffectiveSubscription — access without waiting for the cron", () => {
  it("reports ACTIVE at the trial boundary before anything is materialised", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    await startTrial("h1", { durationDays: 14 });
    await assignPlanToHotel("h1", PLAN_INR.id);

    const atBoundary = await getEffectiveSubscription("h1", new Date("2026-08-29T00:00:00Z"));

    expect(atBoundary!.status).toBe("ACTIVE");
    expect(atBoundary!.suspended).toBe(false);
    expect(atBoundary!.trialConverted).toBe(true);
    expect(atBoundary!.needsMaterialization).toBe(true);
    expect(atBoundary!.periodStart.toISOString()).toBe("2026-08-29T00:00:00.000Z");
    // Nothing has been written yet — the DB still holds the trial.
    expect((await getCurrentSubscription("h1"))!.status).toBe("TRIALING");
  });

  it("suspends an unscheduled trial at the boundary instant, not 30 minutes later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    await startTrial("h1", { durationDays: 14 });

    const before = await getEffectiveSubscription("h1", new Date("2026-08-28T23:59:59.999Z"));
    const after = await getEffectiveSubscription("h1", new Date("2026-08-29T00:00:00Z"));

    expect(before!.status).toBe("TRIALING");
    expect(before!.suspended).toBe(false);
    expect(after!.status).toBe("EXPIRED");
    expect(after!.suspended).toBe(true);
  });

  it("reports the rolled period for a paid subscription the cron has not renewed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    await assignPlanToHotel("h1", PLAN_INR.id);

    const effective = await getEffectiveSubscription("h1", new Date("2026-09-20T00:00:00Z"));

    expect(effective!.status).toBe("ACTIVE");
    expect(effective!.periodStart.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(effective!.periodEnd!.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("a warm cache cannot serve a stale verdict across a boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    await startTrial("h1", { durationDays: 14 });
    await assignPlanToHotel("h1", PLAN_INR.id);

    // Warm the cache while still trialing…
    expect((await getEffectiveSubscription("h1", new Date("2026-08-20T00:00:00Z")))!.status).toBe("TRIALING");
    // …then read past the boundary WITHOUT invalidating. The cached value is the
    // raw row; the verdict is recomputed against the clock every time.
    expect((await getEffectiveSubscription("h1", new Date("2026-08-29T00:00:00Z")))!.status).toBe("ACTIVE");
  });

  it("returns null for a hotel that does not exist", async () => {
    expect(await getEffectiveSubscription("nope")).toBeNull();
  });
});

describe("schedulePlanAtTrialEnd", () => {
  it("refuses when the hotel is not trialing", async () => {
    await expect(schedulePlanAtTrialEnd("h1", PLAN_INR.id)).rejects.toThrow("Hotel is not on a trial");
  });

  it("can be re-pointed at a different plan before the boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    await startTrial("h1", { durationDays: 14 });

    await schedulePlanAtTrialEnd("h1", PLAN_INR.id);
    await schedulePlanAtTrialEnd("h1", PLAN_USD.id);

    expect((await getCurrentSubscription("h1"))!.scheduledPlanId).toBe(PLAN_USD.id);

    await convertDueTrials(new Date("2026-08-29T00:00:00Z"));
    expect((await getCurrentSubscription("h1"))!.currency).toBe("USD");
  });
});

describe("extendSubscription — goodwill without moving the billing day", () => {
  it("moves only this period's end and pins the anchor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    await assignPlanToHotel("h1", PLAN_INR.id); // 15 Aug → 15 Sep, anchor 15

    await extendSubscription("h1", 20);

    const sub = await getCurrentSubscription("h1");
    expect(sub!.endDate!.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    // The recurring day must NOT follow the extension.
    expect(sub!.billingAnchorDay).toBe(15);
  });

  it("does not hand out a free month when the extension lands before the anchor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    await assignPlanToHotel("h1", PLAN_INR.id);
    await extendSubscription("h1", 20); // ends 5 Oct, before anchor day 15
    invoices.length = 0;

    await renewDueSubscriptions(new Date("2026-10-06T00:00:00Z"));

    const sub = await getCurrentSubscription("h1");
    // Realigns with a 10-day catch-up period, NOT a 41-day one.
    expect(sub!.startDate.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(sub!.endDate!.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("returns to exact monthly periods on the original anchor afterwards", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    await assignPlanToHotel("h1", PLAN_INR.id);
    await extendSubscription("h1", 20);

    await renewDueSubscriptions(new Date("2026-11-20T00:00:00Z"));

    const sub = await getCurrentSubscription("h1");
    expect(sub!.startDate.toISOString()).toBe("2026-11-15T00:00:00.000Z");
    expect(sub!.endDate!.toISOString()).toBe("2026-12-15T00:00:00.000Z");
  });

  it("pins the anchor from the PRE-extension end on a legacy row", async () => {
    // Null anchor + an extension: deriving the anchor afterwards would read the
    // goodwill date and re-anchor the customer onto it permanently.
    subscriptions.push({
      id: "legacy_x",
      hotelId: "h1",
      planId: PLAN_INR.id,
      status: "ACTIVE",
      planName: "Starter",
      currency: "INR",
      price: PLAN_INR.priceMonthly,
      conversationLimit: 2000,
      aiReplyLimit: 1000,
      extraConversationCharge: 50,
      extraAiReplyCharge: 200,
      startDate: new Date("2026-08-01T00:00:00Z"),
      endDate: new Date("2026-09-01T00:00:00Z"),
      billingAnchorDay: null,
      scheduledPlanId: null,
      autoRenew: true,
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });

    await extendSubscription("h1", 7);

    const sub = await getCurrentSubscription("h1");
    expect(sub!.billingAnchorDay).toBe(1); // NOT 8
    expect(sub!.endDate!.toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });
});

describe("cancelSubscription", () => {
  it("at period end: stops renewal but keeps serving", async () => {
    await assignPlanToHotel("h1", PLAN_INR.id);
    await cancelSubscription("h1", false);

    const sub = await getCurrentSubscription("h1");
    expect(sub!.autoRenew).toBe(false);
    expect(hotels.get("h1")!.subscriptionStatus).toBe("ACTIVE");
  });

  it("immediate: suspends now", async () => {
    await assignPlanToHotel("h1", PLAN_INR.id);
    await cancelSubscription("h1", true);

    expect(hotels.get("h1")!.subscriptionStatus).toBe("EXPIRED");
    expect(subscriptions.find((s) => s.hotelId === "h1")!.status).toBe("CANCELED");
  });

  it("404s a hotel with nothing to cancel", async () => {
    await expect(cancelSubscription("h1", false)).rejects.toThrow("no active subscription");
  });
});

describe("getAdminBillingAnalytics — MRR", () => {
  it("keeps currencies separate instead of summing them into one number", async () => {
    await assignPlanToHotel("h1", PLAN_INR.id);
    await assignPlanToHotel("h2", PLAN_USD.id);

    const result = await getAdminBillingAnalytics();

    // The old code produced 254800 here — ₹2,499 + $49 added together and then
    // rendered by the UI with a hardcoded "$".
    expect(result.mrr).toEqual({ INR: 249900, USD: 4900 });
    expect(result.currencies).toEqual(["INR", "USD"]);
  });

  it("reads the snapshot, so editing a plan's price does not move current MRR", async () => {
    await assignPlanToHotel("h1", PLAN_INR.id);
    plans.get(PLAN_INR.id)!.priceMonthly = 999900;

    const result = await getAdminBillingAnalytics();
    expect(result.mrr["INR"]).toBe(249900);
  });

  it("excludes trials from MRR", async () => {
    await startTrial("h1");
    const result = await getAdminBillingAnalytics();
    expect(result.mrr).toEqual({});
  });
});
