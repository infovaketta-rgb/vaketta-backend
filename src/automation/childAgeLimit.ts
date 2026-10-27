/**
 * childAgeLimit.ts
 *
 * Pure validation for HotelConfig.childAgeLimit — the age ABOVE which a child is
 * counted (and charged) as an adult. ARA applies it as `age > limit` → adult
 * (ara/ages.ts reclassifyGuests), so with the default 12 a 12-year-old is still
 * a child and a 13-year-old is an adult.
 *
 * Bounds 0–17 match the child-age parse range (ara/ages.ts keeps ages 0–17):
 * 17 means nobody is ever promoted, 0 promotes every child aged 1+.
 *
 * Kept dependency-free — imports NOTHING — same as stayDuration.ts, so it can
 * be unit-tested without the controller/service import chain.
 *
 * Unlike clampMaxStayNights this NEVER clamps: a hotel owner who types 18 must
 * be told, not have their value silently changed to 17.
 */

/** Default when a hotel has never set one — equals the schema default. */
export const DEFAULT_CHILD_AGE_LIMIT = 12;
export const MIN_CHILD_AGE_LIMIT = 0;
export const MAX_CHILD_AGE_LIMIT = 17;

export type ChildAgeLimitResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

const INVALID_MESSAGE =
  `Child age limit must be a whole number from ${MIN_CHILD_AGE_LIMIT} to ${MAX_CHILD_AGE_LIMIT}.`;

/**
 * Accepts ONLY a JS number that is an integer within [0, 17]. Rejects strings
 * (even "12"), decimals, NaN, ±Infinity, null, undefined, booleans and anything
 * out of range. Never clamps, never coerces.
 */
export function parseChildAgeLimit(v: unknown): ChildAgeLimitResult {
  if (
    typeof v !== "number" ||
    !Number.isInteger(v) ||
    v < MIN_CHILD_AGE_LIMIT ||
    v > MAX_CHILD_AGE_LIMIT
  ) {
    return { ok: false, error: INVALID_MESSAGE };
  }
  return { ok: true, value: v };
}
