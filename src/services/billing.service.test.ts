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
  $queryRaw: async () => [],

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
          (!where.hotelId || s.hotelId === where.hotelId) && matchStatus(s.status, where.status),
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
    findUnique: async ({ where }: any) => {
      const { hotelId, month } = where.hotelId_month;
      return usageRecords.find((u) => u.hotelId === hotelId && u.month === month) ?? null;
    },
  },

  plan: {
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
  startTrial,
  renewDueSubscriptions,
  expireOverdueSubscriptions,
  getCurrentSubscription,
  cancelSubscription,
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

describe("assignPlanToHotel — the back-dating + proration bug", () => {
  it("starts the period at signup, not at the start of the month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-28T10:00:00Z"));

    await assignPlanToHotel("h1", PLAN_INR.id);

    const hotel = hotels.get("h1")!;
    // The old code set this to 2026-06-01, three days BEFORE `now` — which is
    // why the expiry cron killed late-month signups almost immediately.
    expect(hotel.billingStartDate.toISOString()).toBe("2026-06-28T10:00:00.000Z");
    expect(hotel.billingEndDate.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(hotel.billingEndDate.getTime()).toBeGreaterThan(Date.now());
  });

  it("prorates the first invoice instead of charging a full month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-28T00:00:00Z"));

    await assignPlanToHotel("h1", PLAN_INR.id);

    expect(invoices).toHaveLength(1);
    // 3 of 30 days.
    expect(invoices[0]!.total).toBe(Math.round((249900 * 3) / 30));
    expect(invoices[0]!.total).toBeLessThan(PLAN_INR.priceMonthly);
    expect(invoices[0]!.currency).toBe("INR");
  });

  it("charges the full price when the period is a whole month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));

    await assignPlanToHotel("h1", PLAN_INR.id);
    expect(invoices[0]!.subtotal).toBe(PLAN_INR.priceMonthly);
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
});

describe("renewDueSubscriptions", () => {
  async function setupDueSubscription() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    await assignPlanToHotel("h1", PLAN_INR.id);
    invoices.length = 0; // ignore the first-period invoice
    vi.setSystemTime(new Date("2026-07-01T00:30:00Z")); // period has ended
  }

  it("issues an invoice for the closed period and rolls to the next", async () => {
    await setupDueSubscription();

    const count = await renewDueSubscriptions(new Date("2026-07-01T00:30:00Z"));

    expect(count).toBe(1);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.subtotal).toBe(PLAN_INR.priceMonthly);

    const sub = await getCurrentSubscription("h1");
    expect(sub!.startDate.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(sub!.endDate!.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(hotels.get("h1")!.billingEndDate.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("bills overage from the closed period's usage", async () => {
    await setupDueSubscription();
    usageRecords.push({ hotelId: "h1", month: "2026-06", conversationsUsed: 2500, aiRepliesUsed: 1200 });

    await renewDueSubscriptions(new Date("2026-07-01T00:30:00Z"));

    // 500 extra conversations × 50 + 200 extra AI replies × 200
    expect(invoices[0]!.overageTotal).toBe(500 * 50 + 200 * 200);
    expect(invoices[0]!.total).toBe(PLAN_INR.priceMonthly + 500 * 50 + 200 * 200);
  });

  it("is idempotent — a second tick does not double-invoice", async () => {
    await setupDueSubscription();
    const now = new Date("2026-07-01T00:30:00Z");

    await renewDueSubscriptions(now);
    const afterFirst = invoices.length;
    await renewDueSubscriptions(now);

    expect(invoices).toHaveLength(afterFirst);
    expect(invoices).toHaveLength(1);
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
