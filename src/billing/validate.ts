/**
 * billing/validate.ts
 *
 * Input parsing for money-touching admin endpoints. Pure, dependency-free.
 *
 * WHY THIS EXISTS
 * ---------------
 * `createPlanHandler` presence-checked then blindly `Number()`-ed its inputs:
 * `priceMonthly: "abc"` became NaN, reached Prisma, threw, and surfaced as a
 * **500 with the raw Prisma message**. Negative prices and negative limits
 * passed straight through. Worse, `startTrialHandler` clamped `days` but not
 * `conversationLimit`, so a negative limit made `usage >= -5` permanently true
 * and **silenced the hotel's bot forever**.
 *
 * Deliberately hand-rolled: this repo has no validation library, and the house
 * convention is explicit `Math.max/min` clamping (see trialConfig.controller).
 * Adding zod for six fields would be a new dependency on the hot path.
 */

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: string };
export type Parsed<T> = Ok<T> | Err;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = (error: string): Err => ({ ok: false, error });

/** ISO 4217 is always three letters. Uppercased. */
export function parseCurrency(v: unknown, field = "currency"): Parsed<string> {
  const s = String(v ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) return err(`${field} must be a 3-letter ISO 4217 code (e.g. INR, USD).`);
  return ok(s);
}

/** "ALL" for a global plan, else a 2-letter ISO 3166-1 alpha-2 country. */
export function parseCountry(v: unknown, field = "country"): Parsed<string> {
  const s = String(v ?? "ALL").trim().toUpperCase();
  if (s === "ALL") return ok("ALL");
  if (!/^[A-Z]{2}$/.test(s)) return err(`${field} must be "ALL" or a 2-letter country code.`);
  return ok(s);
}

/**
 * Money in integer minor units. Rejects NaN/Infinity/negative and anything
 * fractional — a fractional paisa is always a caller bug, not something to round
 * away silently.
 */
export function parseMinorAmount(v: unknown, field: string, max = 100_000_000): Parsed<number> {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return err(`${field} must be a number.`);
  if (n < 0) return err(`${field} cannot be negative.`);
  if (!Number.isInteger(n)) return err(`${field} must be a whole number of minor units (e.g. paise).`);
  if (n > max) return err(`${field} is unreasonably large.`);
  return ok(n);
}

/** A usage allowance. 0 means unlimited; negative is the bot-silencing bug. */
export function parseLimit(v: unknown, field: string, max = 100_000_000): Parsed<number> {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return err(`${field} must be a number.`);
  if (n < 0) return err(`${field} cannot be negative (use 0 for unlimited).`);
  if (!Number.isInteger(n)) return err(`${field} must be a whole number.`);
  if (n > max) return err(`${field} is unreasonably large.`);
  return ok(n);
}

/** A whole count inside [min, max] — trial days, grace days, page sizes. */
export function parseIntInRange(v: unknown, field: string, min: number, max: number): Parsed<number> {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return err(`${field} must be a number.`);
  const i = Math.round(n);
  if (i < min || i > max) return err(`${field} must be between ${min} and ${max}.`);
  return ok(i);
}

export function parseNonEmptyString(v: unknown, field: string, max = 200): Parsed<string> {
  const s = String(v ?? "").trim();
  if (!s) return err(`${field} is required.`);
  if (s.length > max) return err(`${field} must be ${max} characters or fewer.`);
  return ok(s);
}

/** Strict boolean — the string "false" is truthy in JS and must not slip through. */
export function parseBoolean(v: unknown, field: string): Parsed<boolean> {
  if (typeof v === "boolean") return ok(v);
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "true") return ok(true);
  if (s === "false") return ok(false);
  return err(`${field} must be true or false.`);
}

/**
 * Collect a set of parsed fields, short-circuiting on the first error.
 *
 * Usage:
 *   const parsed = collect({ name: parseNonEmptyString(body.name, "name"), … });
 *   if (!parsed.ok) return res.status(400).json({ error: parsed.error });
 *   parsed.value.name  // typed
 */
export function collect<T extends Record<string, Parsed<unknown>>>(
  fields: T,
): Parsed<{ [K in keyof T]: T[K] extends Parsed<infer V> ? V : never }> {
  const out: Record<string, unknown> = {};
  for (const [key, parsed] of Object.entries(fields)) {
    if (!parsed.ok) return parsed;
    out[key] = parsed.value;
  }
  return ok(out as { [K in keyof T]: T[K] extends Parsed<infer V> ? V : never });
}
