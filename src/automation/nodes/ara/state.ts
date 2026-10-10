/**
 * ara/state.ts — session-state read/write and the booking output contract.
 *
 * The node is fully stateless outside flowVars[ARA_KEY]. `readState` validates
 * only the three structural fields it has always validated, so NEW AraState
 * fields must be optional: an in-flight session serialised by an older deploy
 * has to keep deserialising.
 */

import { ARA_KEY } from "./constants";
import type {
  AdvancedRoomAllocationDeps,
  AllocationRoom,
  AraState,
} from "./types";

/**
 * Writes the canonical booking output keys into flowVars. Guarded by the
 * presence of bookingRooms — never overwrites an already-confirmed payload.
 * Returns true if it wrote, false if it was a no-op (idempotency).
 */
export function writeOutputContract(flowVars: Record<string, string>, allocated: AllocationRoom[]): boolean {
  if (flowVars["bookingRooms"]) return false; // already confirmed once
  const first = allocated[0];
  if (!first) return false;
  const total  = allocated.reduce((s, r) => s + r.totalPrice, 0);
  const nights = first.nights;

  flowVars["bookingRoomTypeId"]    = first.roomTypeId;
  flowVars["bookingRoomTypeName"]  = first.roomTypeName;
  flowVars["bookingPricePerNight"] = String(first.pricePerNight);
  flowVars["bookingRooms"]         = JSON.stringify(allocated);
  flowVars["bookingTotalPrice"]    = String(total);
  flowVars["bookingNights"]        = String(nights);

  // Flat, message-friendly aliases so {{bookingTotal}} / {{roomCount}} /
  // {{allocatedRooms}} resolve directly (the output schema declares these keys).
  // bookingTotalPrice/bookingRooms are kept above for back-compat.
  flowVars["bookingTotal"]   = String(total);
  flowVars["roomCount"]      = String(allocated.length);
  flowVars["allocatedRooms"] = JSON.stringify(allocated);
  return true;
}
export function readState(flowVars: Record<string, string>): AraState | null {
  const raw = flowVars[ARA_KEY];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.selectedRooms) &&
      parsed.guests && parsed.remainingGuests
    ) {
      return parsed as AraState;
    }
  } catch { /* fall through */ }
  return null;
}

export function writeState(flowVars: Record<string, string>, state: AraState): void {
  flowVars[ARA_KEY] = JSON.stringify(state);
}

export function clearState(flowVars: Record<string, string>): void {
  delete flowVars[ARA_KEY];
}

export async function persist(deps: AdvancedRoomAllocationDeps): Promise<void> {
  const { guestId, hotelId, flowId, currentNodeId, sessionData, flowData, updateSession } = deps;
  await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, {
    ...sessionData,
    flow: { ...flowData },
  });
}
