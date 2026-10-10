/**
 * ara/allocator.ts — the protected allocation engine (pure, no I/O).
 *
 * Base-first / absorb-the-remainder room allocation plus the per-room pricing
 * formula. Every plan the node offers is produced by `allocateRooms`; callers
 * only choose its inputs. The algorithm itself must not be modified.
 */

import { MAX_ROOMS } from "./constants";
import type {
  AllocationConfig,
  AllocationRoom,
  AllocationRoomInput,
} from "./types";

/**
 * Per-room-type pricing config: DB value → node-level fallback. Allocation caps
 * (maxAdults/maxChildren/extra-bed capacity) deliberately keep using the
 * node-level config so inventory behaviour is unchanged; only the price
 * breakdown is room-type specific.
 */
export function resolveRoomConfig(room: AllocationRoomInput, base: AllocationConfig): AllocationConfig {
  return {
    baseAdults:       room.baseAdults       ?? base.baseAdults,
    baseChildren:     room.baseChildren     ?? base.baseChildren,
    maxAdults:        room.maxAdults         ?? base.maxAdults,
    maxChildren:      room.maxChildren       ?? base.maxChildren,
    extraAdultCharge: room.extraAdultCharge ?? base.extraAdultCharge,
    allowExtraBed:    room.allowExtraBed    ?? base.allowExtraBed,
    extraBedCharge:   room.extraBedCharge   ?? base.extraBedCharge,
    // Hotel-wide value from config — no longer per-room (RoomType column dropped).
    childAgeLimit:    base.childAgeLimit,
  };
}

/**
 * Single source of truth for per-room pricing. Given a base price, the room's
 * occupancy, an explicit extra-bed flag and the resolved config, returns the
 * price breakdown. Extra-bed charge applies only when the room type permits one.
 * Used by the allocator, the manual room-pick path, and the manual modifiers.
 */
export function computeRoomPricing(
  basePrice: number,
  adults:    number,
  extraBed:  boolean,
  nights:    number,
  cfg:       AllocationConfig,
): { extraAdultCost: number; extraBedCost: number; pricePerNight: number; totalPrice: number } {
  const extraAdults    = Math.max(0, adults - cfg.baseAdults);
  const extraAdultCost = extraAdults * cfg.extraAdultCharge;
  const extraBedCost   = cfg.allowExtraBed && extraBed ? cfg.extraBedCharge : 0;
  const pricePerNight  = basePrice + extraAdultCost + extraBedCost;
  return { extraAdultCost, extraBedCost, pricePerNight, totalPrice: pricePerNight * nights };
}

// ── Allocation engine (pure) ──────────────────────────────────────────────────

/**
 * Base-first room count for `units` with the absorb rule (unconstrained by
 * availability): open `floor(units/base)` base rooms; if a leftover remains and
 * the base rooms can absorb it toward `max`, keep that count, else open one more
 * (under-filled) room.
 */
export function baseFirstRoomCount(units: number, base: number, max: number): number {
  if (units <= 0) return 0;
  if (base <= 0) return Math.ceil(units / Math.max(1, max));
  const nBase = Math.floor(units / base);
  const r     = units % base;
  if (r === 0) return nBase;
  const spare = nBase * Math.max(0, max - base);
  return r <= spare ? nBase : nBase + 1;
}

/**
 * Distribute `units` into exactly `R` rooms, base-first: lay down `base` per
 * room (never exceeding the remaining units), then absorb any surplus by bumping
 * the FEWEST rooms toward `max`. Rooms may sit under `base` when units < R×base.
 * Precondition: 0 <= units <= R×max.
 */
export function distributeIntoRooms(units: number, R: number, base: number, max: number): number[] {
  if (R <= 0) return [];
  const baseEach = base > 0 ? base : max;
  const per = new Array<number>(R).fill(0);
  let remaining = units;
  for (let i = 0; i < R; i++) {
    const give = Math.min(baseEach, remaining);
    per[i] = give;
    remaining -= give;
  }
  const perRoomSpare = Math.max(0, max - baseEach);
  for (let i = 0; i < R && remaining > 0 && perRoomSpare > 0; i++) {
    const give = Math.min(perRoomSpare, remaining);
    per[i] = (per[i] ?? 0) + give;
    remaining -= give;
  }
  return per;
}

/**
 * Base-first / absorb-the-remainder allocator.
 *
 * Default to BASE occupancy (no extra beds). Only push a room toward MAX (which
 * adds an extra bed, per the invariant, when allowed) when doing so ELIMINATES an
 * otherwise under-filled extra room; use as few max-occupancy rooms as possible.
 * Children then fill the rooms (up to maxChildren), overflowing into extra rooms.
 * Room types are filled cheapest-first so price is the natural tie-break;
 * availability is a hard constraint (spill to the next type; graceful failure —
 * null — if no combination houses everyone).
 *
 * Invariant: a room has an extra bed iff adults > baseAdults && allowExtraBed.
 * The allocation SHAPE uses the node-level config (base/max); per-type config
 * only affects the price breakdown + the extra-bed flag (allowExtraBed).
 */
export function allocateRooms(args: {
  adults:   number;
  children: number;
  rooms:    AllocationRoomInput[];
  config:   AllocationConfig;
  nights:   number;
  /** "base-first" (default) keeps base occupancy / fewer beds; "max-fill"
   *  minimises room count by cramming each room toward max occupancy. */
  strategy?: "base-first" | "max-fill";
}): AllocationRoom[] | null {
  const { adults, children, rooms, config, nights } = args;
  const strategy = args.strategy ?? "base-first";

  if (adults <= 0 && children <= 0) return [];
  if (nights <= 0) return null;

  const baseA = Math.max(1, config.baseAdults);
  const maxA  = Math.max(baseA, config.maxAdults);
  const baseC = Math.max(0, config.baseChildren);
  const maxC  = Math.max(0, config.maxChildren);

  const availTotal = rooms.reduce((s, r) => s + Math.max(0, r.availableCount), 0);
  if (availTotal <= 0) return null;

  // ── Adults drive the room count ──
  // base-first → absorb the remainder (fewer beds); max-fill → fewest rooms.
  let R = 0;
  let adultCounts: number[] = [];
  if (adults > 0) {
    const wanted = strategy === "max-fill"
      ? Math.ceil(adults / maxA)               // minimise rooms
      : baseFirstRoomCount(adults, baseA, maxA); // base-first / absorb
    if (wanted <= availTotal) {
      R = wanted;
    } else {
      R = availTotal;                       // availability-limited → cram available rooms
      if (R * maxA < adults) return null;   // can't house everyone even at max occupancy
    }
    adultCounts = distributeIntoRooms(adults, R, baseA, maxA);
  }

  // ── Children fill the adult rooms (up to maxChildren), then overflow rooms ──
  const childCounts = new Array<number>(R).fill(0);
  let remC = children;
  for (let i = 0; i < R && remC > 0 && maxC > 0; i++) {
    const give = Math.min(maxC, remC);
    childCounts[i] = give;
    remC -= give;
  }
  let overflowChildRooms: number[] = [];
  if (remC > 0) {
    if (maxC <= 0) return null;             // rooms can't hold children at all
    const cb = baseC > 0 ? baseC : maxC;
    const Rc = baseFirstRoomCount(remC, cb, maxC);
    overflowChildRooms = distributeIntoRooms(remC, Rc, cb, maxC);
  }

  const totalRooms = R + overflowChildRooms.length;
  if (totalRooms === 0) return [];
  if (totalRooms > availTotal || totalRooms > MAX_ROOMS) return null;

  // Room shapes: adult(+child) rooms first, then any child-only overflow rooms.
  const shapes: { adults: number; children: number }[] = [];
  for (let i = 0; i < R; i++) shapes.push({ adults: adultCounts[i]!, children: childCounts[i]! });
  for (const cc of overflowChildRooms) shapes.push({ adults: 0, children: cc });

  // Assign shapes to type slots: cheapest types first (minimises base price),
  // heaviest shapes onto the cheapest slots.
  const typesByPrice = [...rooms].sort((a, b) => a.basePrice - b.basePrice);
  const slots: AllocationRoomInput[] = [];
  for (const t of typesByPrice) {
    for (let i = 0; i < Math.max(0, t.availableCount); i++) slots.push(t);
  }
  const useSlots = slots.slice(0, totalRooms);
  const sortedShapes = [...shapes].sort((a, b) => b.adults - a.adults || b.children - a.children);

  const allocated: AllocationRoom[] = [];
  for (let i = 0; i < totalRooms; i++) {
    const slot  = useSlots[i]!;
    const shape = sortedShapes[i]!;
    const rc    = resolveRoomConfig(slot, config);
    const extraBed = shape.adults > rc.baseAdults && rc.allowExtraBed;
    const p = computeRoomPricing(slot.basePrice, shape.adults, extraBed, nights, rc);
    allocated.push({
      roomTypeId:    slot.roomTypeId,
      roomTypeName:  slot.name,
      adults:        shape.adults,
      children:      shape.children,
      extraBed,
      basePrice:     slot.basePrice,
      extraAdultCost: p.extraAdultCost,
      extraBedCost:   p.extraBedCost,
      childAgeLimit: rc.childAgeLimit,
      pricePerNight:  p.pricePerNight,
      nights,
      totalPrice:     p.totalPrice,
    });
  }
  return allocated;
}
