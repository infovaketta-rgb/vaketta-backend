import { describe, it, expect } from "vitest";
import { computeOverage, unitsOverLimit, ZERO_OVERAGE } from "./overage";

const terms = {
  conversationLimit: 1000,
  aiReplyLimit: 500,
  extraConversationCharge: 50, // ₹0.50 in paise
  extraAiReplyCharge: 200,     // ₹2.00 in paise
};

describe("unitsOverLimit", () => {
  it("bills only the units beyond the allowance", () => {
    expect(unitsOverLimit(1200, 1000)).toBe(200);
  });

  it("treats limit 0 as unlimited", () => {
    expect(unitsOverLimit(999_999, 0)).toBe(0);
  });

  it("is 0 at and below the limit — the boundary is inclusive of the allowance", () => {
    expect(unitsOverLimit(999, 1000)).toBe(0);
    expect(unitsOverLimit(1000, 1000)).toBe(0);
    expect(unitsOverLimit(1001, 1000)).toBe(1);
  });

  it("never returns NaN or a negative for corrupt input", () => {
    for (const bad of [NaN, Infinity, -5, null, undefined, "abc"]) {
      expect(unitsOverLimit(bad, 1000)).toBe(0);
      expect(unitsOverLimit(2000, bad)).toBe(0); // unparseable limit → unlimited
    }
  });
});

describe("computeOverage", () => {
  it("returns zeros when within both limits", () => {
    const r = computeOverage({ conversationsUsed: 800, aiRepliesUsed: 400 }, terms);
    expect(r).toEqual(ZERO_OVERAGE);
  });

  it("charges each meter at its own rate", () => {
    const r = computeOverage({ conversationsUsed: 1200, aiRepliesUsed: 600 }, terms);
    expect(r.conversationOverage).toBe(200);
    expect(r.aiReplyOverage).toBe(100);
    expect(r.conversationCharge).toBe(200 * 50);
    expect(r.aiReplyCharge).toBe(100 * 200);
    expect(r.total).toBe(200 * 50 + 100 * 200);
  });

  it("charges only the meter that is over", () => {
    const r = computeOverage({ conversationsUsed: 1200, aiRepliesUsed: 100 }, terms);
    expect(r.conversationCharge).toBe(10_000);
    expect(r.aiReplyCharge).toBe(0);
    expect(r.total).toBe(10_000);
  });

  it("bills nothing on an unlimited plan no matter the usage", () => {
    const unlimited = { ...terms, conversationLimit: 0, aiReplyLimit: 0 };
    const r = computeOverage({ conversationsUsed: 500_000, aiRepliesUsed: 500_000 }, unlimited);
    expect(r.total).toBe(0);
  });

  it("bills nothing when the plan has no overage rate", () => {
    const noRates = { ...terms, extraConversationCharge: 0, extraAiReplyCharge: 0 };
    const r = computeOverage({ conversationsUsed: 5000, aiRepliesUsed: 5000 }, noRates);
    expect(r.conversationOverage).toBe(4000); // still reported…
    expect(r.total).toBe(0);                  // …but free
  });

  it("always produces integer minor units", () => {
    const r = computeOverage({ conversationsUsed: 1337, aiRepliesUsed: 777 }, terms);
    for (const v of [r.conversationCharge, r.aiReplyCharge, r.total]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("never yields NaN money from a corrupt subscription row", () => {
    const corrupt = {
      conversationLimit: NaN,
      aiReplyLimit: -10,
      extraConversationCharge: NaN,
      extraAiReplyCharge: Infinity,
    } as never;
    const r = computeOverage({ conversationsUsed: 9999, aiRepliesUsed: 9999 }, corrupt);
    expect(Number.isFinite(r.total)).toBe(true);
    expect(r.total).toBe(0);
  });

  it("total is exactly the sum of its parts (invoice line items must reconcile)", () => {
    const r = computeOverage({ conversationsUsed: 4321, aiRepliesUsed: 1234 }, terms);
    expect(r.total).toBe(r.conversationCharge + r.aiReplyCharge);
  });
});
