/**
 * ara/dates.ts — stay-length resolution for the node's two date entry points.
 *
 * A bad/reversed date is RECOVERABLE: prefer `retryStep` (re-ask just that date,
 * keep every other answer) and only reset when no rewind is possible.
 */

import { clearState } from "./state";
import type { AdvancedRoomAllocationDeps } from "./types";

/**
 * Shared guard for the node's two date entry points (phase1 and
 * finishAgeCollection). Returns the night count, or a guest-facing message when
 * the dates are unusable.
 *
 * A bad/reversed date is RECOVERABLE: prefer `retryStep` (re-ask just that date,
 * keep everything else) and only reset when no rewind is possible — an unmapped
 * variable or an exhausted retry budget. Both call sites go through here so the
 * two paths can't drift apart.
 */
export async function resolveNightsOrExplain(
  deps: AdvancedRoomAllocationDeps,
): Promise<{ nights: number; checkIn: string; checkOut: string } | { message: string | null }> {
  const { hotelId, guestId, flowData, resetSession, retryStep } = deps;
  const vars = flowData.flowVars;
  const checkIn = vars["bookingCheckIn"];
  const checkOut = vars["bookingCheckOut"];

  if (!checkIn || !checkOut) {
    const missing = !checkIn ? "bookingCheckIn" : "bookingCheckOut";
    if (retryStep) {
      // Any cached allocation was computed from dates we're about to change.
      clearState(vars);
      const retried = await retryStep(
        missing,
        "I still need your stay dates to suggest rooms — let's fill that in. 👍",
      );
      if (retried !== null) return { message: retried };
    }
    await resetSession(guestId, hotelId);
    return { message: "I don't have your check-in / check-out dates yet. Please start over from the main menu." };
  }

  const nights = countNights(checkIn, checkOut);
  if (nights <= 0) {
    if (retryStep) {
      clearState(vars);
      const retried = await retryStep(
        "bookingCheckOut",
        `Your check-out date (${checkOut}) must be *after* your check-in date (${checkIn}). ` +
          `Let's fix just that — everything else is saved. 👍`,
      );
      if (retried !== null) return { message: retried };
    }
    await resetSession(guestId, hotelId);
    return { message: "Check-out must be after check-in. Please start over from the main menu." };
  }

  return { nights, checkIn, checkOut };
}

export function countNights(checkIn: string, checkOut: string): number {
  const ci = Date.parse(`${checkIn}T00:00:00Z`);
  const co = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(ci) || !Number.isFinite(co) || co <= ci) return 0;
  return Math.round((co - ci) / 86_400_000);
}
