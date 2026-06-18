/**
 * stayDuration.ts
 *
 * Pure helpers for validating booking stay length BEFORE any expensive DB /
 * availability work runs. A guest entering an absurd checkout date (e.g. ~2000
 * years out) used to OOM the server: availability/calendar code expands the
 * range into a per-night array, so nights count must be bounded early.
 *
 * Kept dependency-free — imports NOTHING — so it can be unit-tested without
 * pulling in flowRuntime's heavy module-load chain (Redis throws at import when
 * REDIS_URL is unset, plus Prisma/queues/AI). Mirrors bookingAllocation.ts.
 */

/** Default per-hotel max stay when HotelConfig.maxStayNights is unset. */
export const DEFAULT_MAX_STAY_NIGHTS = 60;

/**
 * In-code fallback ceiling used ONLY when the live platform ceiling
 * (PlatformSettings.maxStayNightsCeiling) can't be read — e.g. the singleton row
 * is somehow missing or the DB read fails. The platform ceiling is now the live
 * source of truth (superadmin-editable); this constant is the last-resort crash
 * guard against the OOM scenario, NOT a realistic-stay assumption. 10 years.
 */
export const HARD_MAX_STAY_NIGHTS = 3650;

/** Nights between two dates, clamped to >= 1 (matches create_booking's calc). */
export function nightsBetween(checkIn: Date, checkOut: Date): number {
  return Math.max(1, Math.ceil((checkOut.getTime() - checkIn.getTime()) / 86_400_000));
}

/**
 * The single shared clamp used by EVERY write path that persists a maxStayNights
 * value (hotel override, and any future caller). Pins a requested value into
 * [1, platformCeiling] so no write can exceed the platform-wide ceiling — not
 * even a superadmin's. Callers resolve `platformCeiling` from
 * PlatformSettings.maxStayNightsCeiling (falling back to HARD_MAX_STAY_NIGHTS
 * when the row is missing).
 */
export function clampMaxStayNights(requested: number, platformCeiling: number): number {
  return Math.min(Math.max(1, requested), platformCeiling);
}

/**
 * True when `nights` exceeds the hotel's configured cap. `maxStayNights` falls
 * back to DEFAULT_MAX_STAY_NIGHTS when null/undefined/non-finite. The configured
 * value is itself clamped to the LIVE `platformCeiling` (passed in by the caller
 * from PlatformSettings.maxStayNightsCeiling) so a stale/misconfigured hotel row
 * can never re-open the OOM hole. `platformCeiling` falls back to
 * HARD_MAX_STAY_NIGHTS when the caller couldn't read the platform row.
 */
export function exceedsMaxStay(
  nights: number,
  maxStayNights?: number | null,
  platformCeiling: number = HARD_MAX_STAY_NIGHTS,
): boolean {
  const configured =
    typeof maxStayNights === "number" && Number.isFinite(maxStayNights) && maxStayNights > 0
      ? maxStayNights
      : DEFAULT_MAX_STAY_NIGHTS;
  const ceiling = Number.isFinite(platformCeiling) && platformCeiling > 0
    ? platformCeiling
    : HARD_MAX_STAY_NIGHTS;
  const cap = Math.min(configured, ceiling);
  return nights > cap;
}

/** User-facing message when a stay is too long / the date range looks invalid. */
export const STAY_TOO_LONG_MESSAGE =
  "⚠️ That date range looks invalid — please enter a valid check-in and check-out date.";
