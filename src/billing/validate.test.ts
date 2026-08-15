import { describe, it, expect } from "vitest";
import {
  parseCurrency,
  parseCountry,
  parseMinorAmount,
  parseLimit,
  parseIntInRange,
  parseNonEmptyString,
  parseBoolean,
  collect,
} from "./validate";

describe("parseCurrency", () => {
  it("accepts and uppercases a 3-letter code", () => {
    expect(parseCurrency("inr")).toEqual({ ok: true, value: "INR" });
    expect(parseCurrency(" usd ")).toEqual({ ok: true, value: "USD" });
  });

  it("rejects anything that is not ISO 4217 shaped", () => {
    for (const bad of ["ZZZZZ", "US", "", null, undefined, 123]) {
      expect(parseCurrency(bad).ok).toBe(false);
    }
  });
});

describe("parseCountry", () => {
  it("defaults to ALL and accepts a 2-letter code", () => {
    expect(parseCountry(undefined)).toEqual({ ok: true, value: "ALL" });
    expect(parseCountry("in")).toEqual({ ok: true, value: "IN" });
    expect(parseCountry("ALL")).toEqual({ ok: true, value: "ALL" });
  });

  it("rejects a malformed code", () => {
    expect(parseCountry("INDIA").ok).toBe(false);
    expect(parseCountry("I").ok).toBe(false);
  });
});

describe("parseMinorAmount — the NaN-to-500 bug", () => {
  it('rejects "abc" instead of letting NaN reach Prisma', () => {
    const r = parseMinorAmount("abc", "priceMonthly");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("priceMonthly");
  });

  it("rejects negative prices", () => {
    expect(parseMinorAmount(-1, "priceMonthly").ok).toBe(false);
  });

  it("rejects fractional minor units", () => {
    expect(parseMinorAmount(49.5, "priceMonthly").ok).toBe(false);
  });

  it("rejects Infinity and absurd values", () => {
    expect(parseMinorAmount(Infinity, "priceMonthly").ok).toBe(false);
    expect(parseMinorAmount(1e12, "priceMonthly").ok).toBe(false);
  });

  it("accepts 0 (a free plan) and normal integers, from number or string", () => {
    expect(parseMinorAmount(0, "priceMonthly")).toEqual({ ok: true, value: 0 });
    expect(parseMinorAmount(249900, "priceMonthly")).toEqual({ ok: true, value: 249900 });
    expect(parseMinorAmount("249900", "priceMonthly")).toEqual({ ok: true, value: 249900 });
  });
});

describe("parseLimit — the bot-silencing bug", () => {
  it("rejects a negative limit (made `usage >= -5` always true, silencing the bot)", () => {
    const r = parseLimit(-5, "conversationLimit");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unlimited");
  });

  it("accepts 0 as unlimited", () => {
    expect(parseLimit(0, "conversationLimit")).toEqual({ ok: true, value: 0 });
  });

  it("rejects NaN and fractional limits", () => {
    expect(parseLimit("abc", "aiReplyLimit").ok).toBe(false);
    expect(parseLimit(10.5, "aiReplyLimit").ok).toBe(false);
  });
});

describe("parseIntInRange", () => {
  it("accepts values inside the range and rounds", () => {
    expect(parseIntInRange(14, "days", 1, 365)).toEqual({ ok: true, value: 14 });
    expect(parseIntInRange("14.4", "days", 1, 365)).toEqual({ ok: true, value: 14 });
  });

  it("rejects rather than silently clamping out-of-range input", () => {
    expect(parseIntInRange(0, "days", 1, 365).ok).toBe(false);
    expect(parseIntInRange(9999, "days", 1, 365).ok).toBe(false);
    expect(parseIntInRange("abc", "days", 1, 365).ok).toBe(false);
  });
});

describe("parseNonEmptyString", () => {
  it("trims and requires content", () => {
    expect(parseNonEmptyString("  Starter ", "name")).toEqual({ ok: true, value: "Starter" });
    expect(parseNonEmptyString("   ", "name").ok).toBe(false);
    expect(parseNonEmptyString(undefined, "name").ok).toBe(false);
  });

  it("enforces a max length", () => {
    expect(parseNonEmptyString("x".repeat(201), "name", 200).ok).toBe(false);
  });
});

describe("parseBoolean", () => {
  it('does not treat the string "false" as true', () => {
    expect(parseBoolean("false", "isActive")).toEqual({ ok: true, value: false });
    expect(parseBoolean(false, "isActive")).toEqual({ ok: true, value: false });
    expect(parseBoolean("true", "isActive")).toEqual({ ok: true, value: true });
  });

  it("rejects anything else rather than coercing", () => {
    expect(parseBoolean("yes", "isActive").ok).toBe(false);
    expect(parseBoolean(1, "isActive").ok).toBe(false);
  });
});

describe("collect", () => {
  it("returns all values when every field parses", () => {
    const r = collect({
      name: parseNonEmptyString("Starter", "name"),
      currency: parseCurrency("inr"),
      priceMonthly: parseMinorAmount(249900, "priceMonthly"),
    });
    expect(r).toEqual({ ok: true, value: { name: "Starter", currency: "INR", priceMonthly: 249900 } });
  });

  it("short-circuits on the first failure and surfaces its message", () => {
    const r = collect({
      name: parseNonEmptyString("Starter", "name"),
      priceMonthly: parseMinorAmount("abc", "priceMonthly"),
      conversationLimit: parseLimit(-1, "conversationLimit"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("priceMonthly");
  });
});
