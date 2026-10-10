/**
 * ara/inventory.ts — turns room types + the availability calendar into the
 * allocator's room inputs. Availability for a stay is the MINIMUM across every
 * night in the range.
 */

import type {
  AllocationRoomInput,
  FetchRoomTypesFn,
  GetCalendarDataFn,
} from "./types";

export async function buildInventoryRooms(
  hotelId:   string,
  checkIn:   string,
  checkOut:  string,
  fetchRoomTypes: FetchRoomTypesFn,
  getCalendarData: GetCalendarDataFn,
): Promise<AllocationRoomInput[]> {
  const rooms = await fetchRoomTypes(hotelId);
  if (rooms.length === 0) return [];

  const calendar = await getCalendarData(hotelId, checkIn, checkOut);

  return rooms.map((r) => {
    let minAvail = Infinity;
    for (const ds of calendar.dates) {
      const cell  = calendar.cells[r.id]?.[ds];
      const avail = cell?.availableRooms ?? 0;
      if (avail < minAvail) minAvail = avail;
    }
    const availableCount = minAvail === Infinity ? 0 : minAvail;
    return {
      roomTypeId:    r.id,
      name:          r.name,
      basePrice:     r.basePrice,
      maxAdults:     r.maxAdults,
      maxChildren:   r.maxChildren,
      availableCount,
      description:      r.description     ?? null,
      baseAdults:       r.baseAdults       ?? null,
      baseChildren:     r.baseChildren     ?? null,
      extraAdultCharge: r.extraAdultCharge ?? null,
      allowExtraBed:    r.allowExtraBed    ?? null,
      extraBedCharge:   r.extraBedCharge   ?? null,
    };
  });
}
