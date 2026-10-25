/**
 * ara/plans.legacy.ts — DEPRECATED three-plan generator.
 *
 * Off the runtime path: the node calls `generateSmartPlans` (./plans) only.
 * Parked here so the split stays mechanical and its existing tests keep passing;
 * delete this file and its tests together in the cleanup stage.
 */

import { allocateRooms } from "./allocator";
import { toPlan } from "./plans";
import type {
  AllocationConfig,
  AllocationPlan,
  AllocationRoomInput,
} from "./types";

/**
 * Generate up to 3 meaningfully different allocation plans:
 *   A "comfort" — base-first (current default suggestion).
 *   B "value"   — max-fill (minimise room count).
 *   C "premium" — base-first on the next-cheapest type (skip the cheapest).
 * Deduplicates by (roomCount, totalPrice, extraBedCount). Returns [] if nothing
 * fits, [one] when only a single unique plan exists (no carousel needed), or
 * 2–3 plans sorted by score = roomCount × averagePricePerRoom (lowest first).
 */
export function generatePlans(params: {
  adults:   number;
  children: number;
  rooms:    AllocationRoomInput[];
  config:   AllocationConfig;
  nights:   number;
}): AllocationPlan[] {
  const { adults, children, rooms, config, nights } = params;
  const candidates: AllocationPlan[] = [];

  const a = allocateRooms({ adults, children, rooms, config, nights });
  if (a && a.length) candidates.push(toPlan("Most Comfortable", "comfort", a, nights));

  const b = allocateRooms({ adults, children, rooms, config, nights, strategy: "max-fill" });
  if (b && b.length) candidates.push(toPlan("Fewer Rooms", "value", b, nights));

  // Premium: drop the single cheapest type, base-first on the rest.
  const cheapest = [...rooms].sort((x, y) => x.basePrice - y.basePrice)[0];
  if (cheapest) {
    const premiumRooms = rooms.filter((r) => r.roomTypeId !== cheapest.roomTypeId);
    if (premiumRooms.length > 0) {
      const c = allocateRooms({ adults, children, rooms: premiumRooms, config, nights });
      if (c && c.length) candidates.push(toPlan("Premium", "premium", c, nights));
    }
  }

  // Deduplicate by (roomCount, totalPrice, extraBedCount).
  const seen = new Set<string>();
  const unique = candidates.filter((p) => {
    const key = `${p.roomCount}|${p.totalPrice}|${p.extraBedCount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by score = roomCount × averagePricePerRoom (lowest first) — surfaces the
  // most efficient allocation regardless of whether efficiency is fewer or cheaper rooms.
  const score = (p: AllocationPlan): number =>
    p.roomCount > 0 ? p.roomCount * (p.totalPrice / p.roomCount) : 0;
  unique.sort((x, y) => score(x) - score(y));
  return unique;
}
