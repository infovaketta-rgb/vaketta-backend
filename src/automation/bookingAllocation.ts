/**
 * bookingAllocation.ts
 *
 * Pure helpers for the multi-room (advanced_room_allocation) create_booking path.
 *
 * Kept dependency-free — imports NOTHING — so it can be unit-tested without
 * pulling in flowRuntime's heavy module-load chain (Redis throws at import when
 * REDIS_URL is unset, plus Prisma/queues/AI). Mirrors the same isolation
 * principle as advancedRoomAllocation.ts.
 */

/**
 * Group an allocation array (the `bookingRooms` flowVar JSON) by `roomTypeId`
 * and count how many rooms of each type were allocated. Rooms with a missing or
 * non-string `roomTypeId` are skipped (defensive against malformed JSON).
 *
 * Used by create_booking to verify availability per room type (need N rooms of a
 * type, not just one) before writing any Booking rows.
 */
export function aggregateRoomQuantities(
  rooms: Array<{ roomTypeId?: string | null }>,
): { roomTypeId: string; quantity: number }[] {
  const counts = new Map<string, number>();
  for (const r of rooms) {
    const id = r?.roomTypeId;
    if (typeof id !== "string" || id === "") continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return Array.from(counts, ([roomTypeId, quantity]) => ({ roomTypeId, quantity }));
}
