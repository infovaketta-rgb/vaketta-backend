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
 *    bot because Redis or Postgres blipped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubscriptionStatus } from "@prisma/client";

let usageRow: { conversationsUsed: number; aiRepliesUsed: number } | null;
let currentSub: Record<string, any> | null;
let statusValue: SubscriptionStatus | null;
let statusThrows: boolean;
let subThrows: boolean;

const db = {
  usageRecord: {
    findUnique: async () => usageRow,
    upsert: async () => ({}),
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
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { isSuspended, isOverQuota, isAIReplyOverQuota, currentMonth } from "./usage.service";

const SUB = {
  conversationLimit: 1000,
  aiReplyLimit: 500,
  extraConversationCharge: 50,
  extraAiReplyCharge: 200,
};

beforeEach(() => {
  usageRow = { conversationsUsed: 0, aiRepliesUsed: 0 };
  currentSub = { ...SUB };
  statusValue = SubscriptionStatus.ACTIVE;
  statusThrows = false;
  subThrows = false;
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
    currentSub = { ...SUB, conversationLimit: 0 };
    usageRow = { conversationsUsed: 500_000, aiRepliesUsed: 0 };
    expect(await isOverQuota("h1")).toBe(false);
  });

  it("is false with no subscription — the legacy free-forever state", async () => {
    currentSub = null;
    usageRow = { conversationsUsed: 500_000, aiRepliesUsed: 0 };
    expect(await isOverQuota("h1")).toBe(false);
  });

  it("fails OPEN on a DB error", async () => {
    subThrows = true;
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
    currentSub = { ...SUB, aiReplyLimit: 0 };
    usageRow = { conversationsUsed: 0, aiRepliesUsed: 1_000_000 };
    expect(await isAIReplyOverQuota("h1")).toBe(false);
  });

  it("is independent of the conversation meter", async () => {
    usageRow = { conversationsUsed: 999_999, aiRepliesUsed: 10 };
    expect(await isAIReplyOverQuota("h1")).toBe(false);
  });

  it("fails OPEN on a DB error", async () => {
    subThrows = true;
    expect(await isAIReplyOverQuota("h1")).toBe(false);
  });

  it("survives a corrupt negative limit instead of silencing the bot forever", async () => {
    // A negative limit used to make `usage >= -5` permanently true. The
    // controller now rejects these, but the read path must be safe regardless.
    currentSub = { ...SUB, aiReplyLimit: -5 };
    usageRow = { conversationsUsed: 0, aiRepliesUsed: 0 };
    expect(await isAIReplyOverQuota("h1")).toBe(false);
  });
});

describe("currentMonth", () => {
  it("uses the platform billing timezone rather than server-local time", async () => {
    const key = await currentMonth(new Date("2026-06-30T20:00:00Z"));
    expect(key).toBe("2026-06"); // mocked config is UTC
    expect(key).toMatch(/^\d{4}-\d{2}$/);
  });
});
