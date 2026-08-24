/**
 * Dunning — renewal reminders, PAST_DUE, and suspension notices.
 *
 * Untested until now, despite being the code that decides when a paying
 * customer's bot stops answering guests and what they are told about it.
 *
 * Locks in:
 *  - notices fire ONCE per period — `hasEvent` is the idempotency store, and a
 *    container restart or a second instance must not re-send;
 *  - `hasEvent` fails CLOSED: if we cannot prove a notice wasn't sent, we don't
 *    send it, because spamming a paying customer beats missing one reminder;
 *  - a notice with no deliverable recipient, or one whose mail transport is
 *    broken, is STILL recorded — otherwise the lookup retries every tick forever;
 *  - a trial with a plan already scheduled gets a handover message, not
 *    "choose a plan before your bot stops";
 *  - suspension only happens past the grace window, and one hotel's failure
 *    never stops the batch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, any>;

let users: Row[];
let hotelRows: Row[];
let subscriptions: Row[];
let justOverdue: Row[];
let pastGrace: Row[];
let sentEmails: Row[];
let auditEvents: Row[];
let seenEvents: Set<string>;
let hasEventFailsClosed: boolean;
let mailThrows: boolean;
let markPastDueResult: boolean;
let gracePeriodDays: number;
let updateManyThrows: boolean;

const db: Row = {
  $transaction: async (fn: any) => fn(db),
  user: {
    findMany: async ({ where }: any) => users.filter((u) => u.hotelId === where.hotelId && u.isActive),
  },
  hotel: {
    findUnique: async ({ where }: any) => hotelRows.find((h) => h.id === where.id) ?? null,
    findMany: async ({ where }: any) =>
      hotelRows.filter((h) => {
        if (where.subscriptionStatus && h.subscriptionStatus !== where.subscriptionStatus) return false;
        const f = where.billingEndDate;
        if (f?.gte && !(h.billingEndDate >= f.gte)) return false;
        if (f?.lte && !(h.billingEndDate <= f.lte)) return false;
        return true;
      }),
    updateMany: async ({ where, data }: any) => {
      if (updateManyThrows) throw new Error("db down");
      const rows = hotelRows.filter(
        (h) => h.id === where.id && (!where.subscriptionStatus?.in || where.subscriptionStatus.in.includes(h.subscriptionStatus)),
      );
      rows.forEach((h) => Object.assign(h, data));
      return { count: rows.length };
    },
  },
  subscription: {
    findMany: async ({ where }: any) =>
      subscriptions.filter((s) => {
        if (where.status?.in && !where.status.in.includes(s.status)) return false;
        if (where.endDate?.gt && !(s.endDate > where.endDate.gt)) return false;
        if (where.endDate?.lte && !(s.endDate <= where.endDate.lte)) return false;
        return true;
      }),
    updateMany: async () => ({ count: 1 }),
  },
};

vi.mock("../db/connect", () => ({
  default: new Proxy({} as any, { get: (_t, p) => (db as any)[p] }),
}));

vi.mock("../utils/mailer", () => ({
  sendEmail: async (to: string, subject: string, html: string, text: string) => {
    if (mailThrows) throw new Error("smtp unreachable");
    sentEmails.push({ to, subject, html, text });
  },
}));

vi.mock("./audit.service", () => ({
  recordBillingEvent: async (type: string, args: any) => {
    auditEvents.push({ type, ...args });
    seenEvents.add(`${type}:${args.hotelId}`);
  },
  hasEvent: async (type: string, hotelId: string) => {
    if (hasEventFailsClosed) return true;
    return seenEvents.has(`${type}:${hotelId}`);
  },
}));

vi.mock("./invoice.service", () => ({
  findOverdueInvoices: async () => pastGrace,
  findJustOverdueInvoices: async () => justOverdue,
}));

vi.mock("./billing.service", () => ({
  getBillingConfig: async () => ({ timezone: "UTC", gracePeriodDays }),
  markPastDue: async () => markPastDueResult,
  LIVE_STATUSES: ["TRIALING", "ACTIVE", "PAST_DUE"],
  invalidateSubscriptionStatusCache: vi.fn(),
}));

const emitToAdmin = vi.fn();
const emitToHotel = vi.fn();
vi.mock("../realtime/emit", () => ({
  emitToAdmin: (...a: any[]) => emitToAdmin(...a),
  emitToHotel: (...a: any[]) => emitToHotel(...a),
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { sendRenewalReminders, advanceDelinquent, notifyRecentlySuspended } from "./dunning.service";

const NOW = new Date("2026-08-20T10:00:00Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const invoice = (over: Row = {}) => ({
  id: "inv_1",
  hotelId: "h1",
  number: "INV-2026-00001",
  dueAt: new Date("2026-08-10T00:00:00Z"),
  total: 249900,
  currency: "INR",
  ...over,
});

beforeEach(() => {
  users = [{ hotelId: "h1", email: "owner@hotel.test", isActive: true, role: "OWNER" }];
  hotelRows = [{ id: "h1", email: "front@hotel.test", subscriptionStatus: "ACTIVE", billingEndDate: NOW }];
  subscriptions = [];
  justOverdue = [];
  pastGrace = [];
  sentEmails = [];
  auditEvents = [];
  seenEvents = new Set();
  hasEventFailsClosed = false;
  mailThrows = false;
  markPastDueResult = true;
  gracePeriodDays = 7;
  updateManyThrows = false;
  emitToAdmin.mockClear();
  emitToHotel.mockClear();
});

// ── Renewal reminders ────────────────────────────────────────────────────────

describe("sendRenewalReminders", () => {
  const sub = (over: Row = {}) => ({
    hotelId: "h1",
    status: "ACTIVE",
    endDate: inDays(3),
    planName: "Starter",
    startDate: new Date("2026-08-01T00:00:00Z"),
    autoRenew: true,
    scheduledPlanId: null,
    ...over,
  });

  it("sends at 7, 3 and 1 days out", async () => {
    for (const days of [7, 3, 1]) {
      subscriptions = [sub({ endDate: inDays(days) })];
      sentEmails = [];
      seenEvents = new Set();
      expect(await sendRenewalReminders(NOW)).toBe(1);
    }
  });

  it("stays silent on a day that is not a reminder day", async () => {
    subscriptions = [sub({ endDate: inDays(5) })];
    expect(await sendRenewalReminders(NOW)).toBe(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("sends only ONCE per period, however often the cron ticks", async () => {
    subscriptions = [sub({ endDate: inDays(3) })];
    expect(await sendRenewalReminders(NOW)).toBe(1);
    expect(await sendRenewalReminders(NOW)).toBe(0);
    expect(sentEmails).toHaveLength(1);
  });

  it("tells a scheduled trial its plan is taking over — not to go choose one", async () => {
    subscriptions = [sub({ status: "TRIALING", scheduledPlanId: "plan_1", endDate: inDays(1) })];
    await sendRenewalReminders(NOW);

    expect(sentEmails[0]!.subject).toMatch(/plan starts tomorrow/i);
    expect(sentEmails[0]!.text).toMatch(/No action needed/i);
    expect(sentEmails[0]!.html).not.toMatch(/choose a plan/i);
  });

  it("warns an unscheduled trial that the bot will stop", async () => {
    subscriptions = [sub({ status: "TRIALING", scheduledPlanId: null, endDate: inDays(3) })];
    await sendRenewalReminders(NOW);

    expect(sentEmails[0]!.subject).toMatch(/trial ends in 3 days/i);
    expect(sentEmails[0]!.html).toMatch(/choose a plan/i);
    // Reassurance that data is not lost is the whole point of the copy.
    expect(sentEmails[0]!.html).toMatch(/conversations and bookings stay available/i);
  });

  it("mails every active ADMIN/OWNER of the hotel", async () => {
    users = [
      { hotelId: "h1", email: "owner@hotel.test", isActive: true },
      { hotelId: "h1", email: "admin@hotel.test", isActive: true },
    ];
    subscriptions = [sub({ endDate: inDays(1) })];
    await sendRenewalReminders(NOW);
    expect(sentEmails.map((e) => e.to).sort()).toEqual(["admin@hotel.test", "owner@hotel.test"]);
  });

  it("falls back to the hotel's own address when no staff user qualifies", async () => {
    users = [];
    subscriptions = [sub({ endDate: inDays(1) })];
    await sendRenewalReminders(NOW);
    expect(sentEmails.map((e) => e.to)).toEqual(["front@hotel.test"]);
  });

  it("records the event even when there is nobody to mail, so the lookup is not retried forever", async () => {
    users = [];
    hotelRows[0]!.email = null;
    subscriptions = [sub({ endDate: inDays(1) })];

    expect(await sendRenewalReminders(NOW)).toBe(0);
    const ev = auditEvents.find((e) => e.type === "notice.renewal_upcoming")!;
    expect(ev.data).toMatchObject({ delivered: false, reason: "no_recipient" });
  });

  it("records the event even when the mail transport is broken", async () => {
    mailThrows = true;
    subscriptions = [sub({ endDate: inDays(1) })];

    expect(await sendRenewalReminders(NOW)).toBe(0);
    const ev = auditEvents.find((e) => e.type === "notice.renewal_upcoming")!;
    expect(ev.data.delivered).toBe(false);
  });

  it("suppresses the notice when hasEvent cannot prove it was unsent (fails closed)", async () => {
    hasEventFailsClosed = true;
    subscriptions = [sub({ endDate: inDays(1) })];

    expect(await sendRenewalReminders(NOW)).toBe(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("notifies the hotel's staff over the socket as well as by email", async () => {
    subscriptions = [sub({ endDate: inDays(1) })];
    await sendRenewalReminders(NOW);
    expect(emitToHotel).toHaveBeenCalledWith("h1", "staff:notification", expect.objectContaining({ kind: "billing" }));
  });
});

// ── Delinquency ──────────────────────────────────────────────────────────────

describe("advanceDelinquent", () => {
  it("flags a just-overdue hotel PAST_DUE and keeps serving it", async () => {
    justOverdue = [invoice()];
    const result = await advanceDelinquent(NOW);

    expect(result.pastDue).toBe(1);
    expect(result.suspended).toBe(0);
    expect(sentEmails[0]!.subject).toMatch(/is overdue/i);
    expect(sentEmails[0]!.html).toMatch(/running normally/i);
  });

  it("names the remaining grace window in the past-due notice", async () => {
    gracePeriodDays = 5;
    justOverdue = [invoice()];
    await advanceDelinquent(NOW);
    expect(sentEmails[0]!.text).toMatch(/5 more days/);
  });

  it("suspends a hotel still unpaid past the grace window", async () => {
    pastGrace = [invoice()];
    const result = await advanceDelinquent(NOW);

    expect(result.suspended).toBe(1);
    expect(hotelRows[0]!.subscriptionStatus).toBe("EXPIRED");
    expect(auditEvents.some((e) => e.type === "subscription.expired" && e.data.reason === "unpaid_invoice")).toBe(true);
    expect(emitToAdmin).toHaveBeenCalledWith(
      "admin:subscription_changed",
      expect.objectContaining({ hotelId: "h1", status: "EXPIRED" }),
    );
  });

  it("promises the customer their data is safe when suspending", async () => {
    pastGrace = [invoice()];
    await advanceDelinquent(NOW);
    expect(sentEmails[0]!.html).toMatch(/Your data is safe/i);
    expect(sentEmails[0]!.html).toMatch(/still sign in and read every conversation/i);
  });

  it("does not double-count a hotel already suspended", async () => {
    hotelRows[0]!.subscriptionStatus = "EXPIRED";
    pastGrace = [invoice()];
    const result = await advanceDelinquent(NOW);
    expect(result.suspended).toBe(0);
  });

  it("does not count a PAST_DUE transition that did not apply", async () => {
    markPastDueResult = false;
    justOverdue = [invoice()];
    const result = await advanceDelinquent(NOW);
    expect(result.pastDue).toBe(0);
    // The notice still goes out — the invoice IS overdue regardless.
    expect(sentEmails).toHaveLength(1);
  });

  it("one hotel's failure never stops the rest of the batch", async () => {
    updateManyThrows = true;
    pastGrace = [invoice({ id: "a", hotelId: "h1" }), invoice({ id: "b", hotelId: "h1" })];
    await expect(advanceDelinquent(NOW)).resolves.toEqual({ pastDue: 0, suspended: 0 });
  });

  it("sends the suspension notice once, not once per tick", async () => {
    pastGrace = [invoice()];
    await advanceDelinquent(NOW);
    hotelRows[0]!.subscriptionStatus = "EXPIRED";
    await advanceDelinquent(NOW);
    expect(sentEmails.filter((e) => /paused/i.test(e.subject))).toHaveLength(1);
  });
});

// ── Suspended-by-date notices ────────────────────────────────────────────────

describe("notifyRecentlySuspended", () => {
  it("notifies hotels whose period simply ran out", async () => {
    hotelRows = [{ id: "h1", email: "front@hotel.test", subscriptionStatus: "EXPIRED", billingEndDate: inDays(-1) }];
    expect(await notifyRecentlySuspended(NOW)).toBe(1);
    expect(sentEmails[0]!.subject).toMatch(/paused/i);
    expect(sentEmails[0]!.html).toMatch(/subscription period ended/i);
  });

  it("ignores hotels suspended longer than the two-day look-back", async () => {
    hotelRows = [{ id: "h1", email: "a@b.test", subscriptionStatus: "EXPIRED", billingEndDate: inDays(-10) }];
    expect(await notifyRecentlySuspended(NOW)).toBe(0);
  });

  it("ignores hotels that are still being served", async () => {
    hotelRows = [{ id: "h1", email: "a@b.test", subscriptionStatus: "ACTIVE", billingEndDate: inDays(-1) }];
    expect(await notifyRecentlySuspended(NOW)).toBe(0);
  });

  it("does not re-notify a hotel already told it was suspended", async () => {
    hotelRows = [{ id: "h1", email: "a@b.test", subscriptionStatus: "EXPIRED", billingEndDate: inDays(-1) }];
    expect(await notifyRecentlySuspended(NOW)).toBe(1);
    expect(await notifyRecentlySuspended(NOW)).toBe(0);
  });
});
