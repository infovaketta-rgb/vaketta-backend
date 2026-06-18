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
 * Hard internal ceiling, independent of any hotel config. Purely a crash guard
 * against the OOM scenario — NOT a realistic-stay assumption. It sits well above
 * any legitimate maxStayNights a hotel might configure (admin UI caps that at
 * 3650 too), so a real long-stay business is never falsely blocked. 10 years.
 */
export const HARD_MAX_STAY_NIGHTS = 3650;

/** Nights between two dates, clamped to >= 1 (matches create_booking's calc). */
export function nightsBetween(checkIn: Date, checkOut: Date): number {
  return Math.max(1, Math.ceil((checkOut.getTime() - checkIn.getTime()) / 86_400_000));
}

/**
 * True when `nights` exceeds the hotel's configured cap. `maxStayNights` falls
 * back to DEFAULT_MAX_STAY_NIGHTS when null/undefined/non-finite. The configured
 * value is itself clamped to HARD_MAX_STAY_NIGHTS so a misconfigured row can
 * never re-open the OOM hole.
 */
export function exceedsMaxStay(nights: number, maxStayNights?: number | null): boolean {
  const configured =
    typeof maxStayNights === "number" && Number.isFinite(maxStayNights) && maxStayNights > 0
      ? maxStayNights
      : DEFAULT_MAX_STAY_NIGHTS;
  const cap = Math.min(configured, HARD_MAX_STAY_NIGHTS);
  return nights > cap;
}

/** User-facing message when a stay is too long / the date range looks invalid. */
export const STAY_TOO_LONG_MESSAGE =
  "⚠️ That date range looks invalid — please enter a valid check-in and check-out date.";
