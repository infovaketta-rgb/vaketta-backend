/**
 * advancedRoomAllocation.ts
 *
 * Self-contained handler for the `advanced_room_allocation` flow node.
 *
 * Architecture notes (per finding #3 follow-up):
 *   • Fully stateless outside flowData.flowVars["__araState__"]. Vaketta deploys
 *     to multiple processes (web + worker on Render); ANY module-level state
 *     would corrupt allocations when requests are load-balanced across instances.
 *   • Imports NOTHING from flowRuntime.ts (would cause a circular import). All
 *     runtime dependencies — fetchRoomTypes, getCalendarData, safeMenu,
 *     advance, nextNodeId, updateSession, resetSession — are injected via the
 *     deps parameter.
 *   • Webhook-retry safe: Phase 1 is idempotent (re-renders existing state
 *     instead of regenerating), Phase 2 confirm guards on bookingRooms before
 *     writing output keys.
 */

import type {
  AdvancedRoomAllocationNodeData,
  SerializedFlowNode,
} from "../flowTypes";
import type { SessionData } from "../../services/session.service";

// ── Public types ──────────────────────────────────────────────────────────────

export type AllocationRoom = {
  roomTypeId:    string;
  roomTypeName:  string;
  adults:        number;
  children:      number;
  extraBed:      boolean;
  basePrice:     number; // room base price per night (for the breakdown line)
  extraAdultCost: number; // extra-adult charge per night (extraAdults * extraAdultCharge)
  extraBedCost:  number; // extra-bed charge per night (0 when not applied)
  childAgeLimit: number | null; // informational; surfaced in the summary note
  pricePerNight: number; // basePrice + extraAdultCost + extraBedCost (per night)
  nights:        number;
  totalPrice:    number; // pricePerNight * nights
};

export type AraState = {
  guests:          { adults: number; children: number; childrenAges?: number[] };
  selectedRooms:   AllocationRoom[];
  remainingGuests: { adults: number; children: number };
  phase:           "confirm" | "manual" | "room_menu" | "move_from_count" | "move_to_room" | "change_type_select" | "plan_selection";
  // Structured-modify navigation (all optional — older state shapes stay valid):
  selectedRoomIndex?: number; // which room the guest is editing (room_menu / move_*)
  pendingMove?: { fromRoomIndex: number; adults: number; children: number };
  // Multi-plan selection (Phase 1 carousel):
  plans?:               AllocationPlan[];      // candidate plans offered to the guest
  selectedPlanIndex?:   number;                // which plan the guest chose
  eligibleRoomInputs?:  AllocationRoomInput[]; // room types used to build plans (for single-type selection)
};

/** One candidate allocation plan offered in the Phase-1 carousel. */
export interface AllocationPlan {
  label:             string;            // "Most Comfortable" | "Fewer Rooms" | "Premium"
  rooms:             AllocationRoom[];
  totalPrice:        number;
  nights:            number;
  roomCount:         number;
  extraBedCount:     number;
  primaryRoomTypeId: string;            // most-used type in this plan (for the photo)
  planTag:           "comfort" | "value" | "premium";
}

export type AllocationRoomInput = {
  roomTypeId:     string;
  name:           string;
  basePrice:      number;
  maxAdults:      number | null;
  maxChildren:    number | null;
  availableCount: number;
  // Per-room-type occupancy/pricing overrides (DB). Null/undefined → fall back
  // to the node-level config. Allocation caps still use the node config; these
  // only influence the per-room price breakdown.
  baseAdults?:       number | null;
  baseChildren?:     number | null;
  extraAdultCharge?: number | null;
  allowExtraBed?:    boolean | null;
  extraBedCharge?:   number | null;
  childAgeLimit?:    number | null;
};

export type AllocationConfig = {
  baseAdults:       number;   // adults included in base price
  baseChildren:     number;   // children included in base price
  maxAdults:        number;   // hard cap per room
  maxChildren:      number;   // hard cap per room
  extraAdultCharge: number;   // per adult per night above baseAdults
  allowExtraBed:    boolean;
  extraBedCharge:   number;   // per night for the extra bed
  childAgeLimit:    number | null; // null = no age-based reclassification
};

/**
 * Per-room-type pricing config: DB value → node-level fallback. Allocation caps
 * (maxAdults/maxChildren/extra-bed capacity) deliberately keep using the
 * node-level config so inventory behaviour is unchanged; only the price
 * breakdown is room-type specific.
 */
function resolveRoomConfig(room: AllocationRoomInput, base: AllocationConfig): AllocationConfig {
  return {
    baseAdults:       room.baseAdults       ?? base.baseAdults,
    baseChildren:     room.baseChildren     ?? base.baseChildren,
    maxAdults:        room.maxAdults         ?? base.maxAdults,
    maxChildren:      room.maxChildren       ?? base.maxChildren,
    extraAdultCharge: room.extraAdultCharge ?? base.extraAdultCharge,
    allowExtraBed:    room.allowExtraBed    ?? base.allowExtraBed,
    extraBedCharge:   room.extraBedCharge   ?? base.extraBedCharge,
    childAgeLimit:    room.childAgeLimit    ?? base.childAgeLimit,
  };
}

/**
 * Single source of truth for per-room pricing. Given a base price, the room's
 * occupancy, an explicit extra-bed flag and the resolved config, returns the
 * price breakdown. Extra-bed charge applies only when the room type permits one.
 * Used by the allocator, the manual room-pick path, and the manual modifiers.
 */
function computeRoomPricing(
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

const MAX_ROOMS = 50;

/**
 * Base-first room count for `units` with the absorb rule (unconstrained by
 * availability): open `floor(units/base)` base rooms; if a leftover remains and
 * the base rooms can absorb it toward `max`, keep that count, else open one more
 * (under-filled) room.
 */
function baseFirstRoomCount(units: number, base: number, max: number): number {
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
function distributeIntoRooms(units: number, R: number, base: number, max: number): number[] {
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

// ── Multi-plan generator (pure, testable) ─────────────────────────────────────

/** Build an AllocationPlan from an allocated room list. */
function toPlan(
  label: AllocationPlan["label"], planTag: AllocationPlan["planTag"],
  rooms: AllocationRoom[], nights: number,
): AllocationPlan {
  const counts = new Map<string, number>();
  for (const r of rooms) counts.set(r.roomTypeId, (counts.get(r.roomTypeId) ?? 0) + 1);
  let primaryRoomTypeId = rooms[0]?.roomTypeId ?? "";
  let best = -1;
  for (const [id, c] of counts) if (c > best) { best = c; primaryRoomTypeId = id; }
  return {
    label, planTag,
    rooms,
    totalPrice:    rooms.reduce((s, r) => s + r.totalPrice, 0),
    nights,
    roomCount:     rooms.length,
    extraBedCount: rooms.filter((r) => r.extraBed).length,
    primaryRoomTypeId,
  };
}

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

// ── Manual modification (pure, testable appliers) ─────────────────────────────
//
// These apply ONE structured operation (the safe set the AI maps to) to the
// current selectedRooms and return the updated rooms with prices recomputed via
// computeRoomPricing. All validation lives here, not in the AI — out-of-range
// indices and disallowed extra beds are rejected, never thrown.

/** Resolves the effective per-room config for an already-allocated room. */
export type RoomConfigResolver = (room: AllocationRoom) => AllocationConfig;

export type ApplyResult =
  | { ok: true;  rooms: AllocationRoom[]; returnedGuests?: { adults: number; children: number } }
  | { ok: false; outOfRange: boolean; reason: string };

function inRange(rooms: AllocationRoom[], i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < rooms.length;
}

/** Reprice a room with an explicit extra-bed flag using the resolved config. */
function repriceRoom(room: AllocationRoom, extraBed: boolean, cfg: AllocationConfig): AllocationRoom {
  const p = computeRoomPricing(room.basePrice, room.adults, extraBed, room.nights, cfg);
  return {
    ...room,
    extraBed,
    extraAdultCost: p.extraAdultCost,
    extraBedCost:   p.extraBedCost,
    pricePerNight:  p.pricePerNight,
    totalPrice:     p.totalPrice,
  };
}

/** Remove the extra bed (no config needed — extra-adult charge is unchanged). */
function stripExtraBed(room: AllocationRoom): AllocationRoom {
  const pricePerNight = room.basePrice + room.extraAdultCost; // extraBedCost → 0
  return { ...room, extraBed: false, extraBedCost: 0, pricePerNight, totalPrice: pricePerNight * room.nights };
}

export function applyAddExtraBed(
  rooms: AllocationRoom[], roomIndex: number, resolveCfg: RoomConfigResolver,
): ApplyResult {
  if (!inRange(rooms, roomIndex)) return { ok: false, outOfRange: true, reason: "" };
  const room = rooms[roomIndex]!;
  const cfg  = resolveCfg(room);
  if (!cfg.allowExtraBed) {
    return { ok: false, outOfRange: false, reason: `${room.roomTypeName} rooms don't support an extra bed.` };
  }
  return { ok: true, rooms: rooms.map((r, i) => (i === roomIndex ? repriceRoom(room, true, cfg) : r)) };
}

export function applyRemoveExtraBed(rooms: AllocationRoom[], roomIndex: number): ApplyResult {
  if (!inRange(rooms, roomIndex)) return { ok: false, outOfRange: true, reason: "" };
  return { ok: true, rooms: rooms.map((r, i) => (i === roomIndex ? stripExtraBed(r) : r)) };
}

export function applyMoveExtraBed(
  rooms: AllocationRoom[], fromIndex: number, toIndex: number, resolveCfg: RoomConfigResolver,
): ApplyResult {
  if (!inRange(rooms, fromIndex) || !inRange(rooms, toIndex) || fromIndex === toIndex) {
    return { ok: false, outOfRange: true, reason: "" };
  }
  const toRoom = rooms[toIndex]!;
  const toCfg  = resolveCfg(toRoom);
  if (!toCfg.allowExtraBed) {
    return { ok: false, outOfRange: false, reason: `${toRoom.roomTypeName} rooms don't support an extra bed.` };
  }
  const updated = rooms.map((r, i) => {
    if (i === fromIndex) return stripExtraBed(r);
    if (i === toIndex)   return repriceRoom(r, true, toCfg);
    return r;
  });
  return { ok: true, rooms: updated };
}

export function applyRemoveRoom(rooms: AllocationRoom[], roomIndex: number): ApplyResult {
  if (!inRange(rooms, roomIndex)) return { ok: false, outOfRange: true, reason: "" };
  const removed = rooms[roomIndex]!;
  return {
    ok: true,
    rooms: rooms.filter((_, i) => i !== roomIndex),
    returnedGuests: { adults: removed.adults, children: removed.children },
  };
}

/**
 * Reprice a room after its occupancy changed via a guest move. Unlike the
 * extra-bed ops (which are the guest's manual override), move_guest
 * AUTO-recomputes the extra bed from the new occupancy: a bed is needed when
 * adults exceed baseAdults AND the room type allows one. If extra beds are not
 * allowed, adults may still rise (up to the maxAdults cap, checked by the
 * caller) with no bed — only the extra-adult charge applies.
 */
function repriceForMove(room: AllocationRoom, adults: number, children: number, cfg: AllocationConfig): AllocationRoom {
  const extraBed = adults > cfg.baseAdults && cfg.allowExtraBed;
  const p = computeRoomPricing(room.basePrice, adults, extraBed, room.nights, cfg);
  return {
    ...room,
    adults,
    children,
    extraBed,
    extraAdultCost: p.extraAdultCost,
    extraBedCost:   p.extraBedCost,
    pricePerNight:  p.pricePerNight,
    totalPrice:     p.totalPrice,
  };
}

/**
 * Move `adults`/`children` from one room to another. Validates indices, that the
 * source holds the guests, and that the destination won't exceed its maxAdults /
 * maxChildren caps. Both involved rooms have their extra bed re-derived from the
 * new occupancy and are re-priced; uninvolved rooms are untouched. An emptied
 * source room is dropped (consolidation). remainingGuests is unaffected — guests
 * only move between existing rooms.
 */
export function applyMoveGuest(
  rooms:      AllocationRoom[],
  fromIndex:  number,
  toIndex:    number,
  adults:     number,
  children:   number,
  resolveCfg: RoomConfigResolver,
): ApplyResult {
  if (!inRange(rooms, fromIndex) || !inRange(rooms, toIndex) || fromIndex === toIndex) {
    return { ok: false, outOfRange: true, reason: "" };
  }
  const a = Number.isFinite(adults)   ? Math.max(0, Math.trunc(adults))   : 0;
  const c = Number.isFinite(children) ? Math.max(0, Math.trunc(children)) : 0;
  if (a === 0 && c === 0) return { ok: false, outOfRange: false, reason: "Nothing to move." };

  const from = rooms[fromIndex]!;
  const to   = rooms[toIndex]!;

  if (from.adults < a || from.children < c) {
    return {
      ok: false, outOfRange: false,
      reason: `Room ${fromIndex + 1} only has ${from.adults} adult${from.adults === 1 ? "" : "s"} and ${from.children} child${from.children === 1 ? "" : "ren"}.`,
    };
  }

  const toCfg         = resolveCfg(to);
  const newToAdults   = to.adults + a;
  const newToChildren = to.children + c;
  if (newToAdults > toCfg.maxAdults) {
    return { ok: false, outOfRange: false, reason: `${to.roomTypeName} rooms hold at most ${toCfg.maxAdults} adult${toCfg.maxAdults === 1 ? "" : "s"}.` };
  }
  if (newToChildren > toCfg.maxChildren) {
    return { ok: false, outOfRange: false, reason: `${to.roomTypeName} rooms hold at most ${toCfg.maxChildren} child${toCfg.maxChildren === 1 ? "" : "ren"}.` };
  }

  const toPriced        = repriceForMove(to, newToAdults, newToChildren, toCfg);
  const newFromAdults   = from.adults - a;
  const newFromChildren = from.children - c;

  let updated: AllocationRoom[];
  if (newFromAdults === 0 && newFromChildren === 0) {
    // Source emptied → drop it (consolidation).
    updated = rooms.map((r, i) => (i === toIndex ? toPriced : r)).filter((_, i) => i !== fromIndex);
  } else {
    const fromPriced = repriceForMove(from, newFromAdults, newFromChildren, resolveCfg(from));
    updated = rooms.map((r, i) => (i === fromIndex ? fromPriced : i === toIndex ? toPriced : r));
  }
  return { ok: true, rooms: updated };
}

/**
 * Switch a room to a different room TYPE in one step (no remove + re-add). Keeps
 * the room's occupancy; validates the target type has availability and can hold
 * the guests, then re-prices and re-derives the extra bed on the new type (a
 * structural change — like move_guest; the explicit *_extra_bed ops are the
 * manual override). Rejects (never throws) on a bad index, the same type,
 * no availability, or an over-cap occupancy.
 */
export function applyChangeRoomType(
  rooms:      AllocationRoom[],
  roomIndex:  number,
  target:     AllocationRoomInput,
  resolveCfg: RoomConfigResolver,
): ApplyResult {
  if (!inRange(rooms, roomIndex)) return { ok: false, outOfRange: true, reason: "" };
  const room = rooms[roomIndex]!;
  if (target.roomTypeId === room.roomTypeId) return { ok: false, outOfRange: true, reason: "" }; // no-op

  // Availability for the target type (don't count the room being converted).
  const usedOfTarget = rooms.filter((r, i) => i !== roomIndex && r.roomTypeId === target.roomTypeId).length;
  if (target.availableCount - usedOfTarget <= 0) {
    return { ok: false, outOfRange: false, reason: `Sorry, no ${target.name} rooms are available for those dates.` };
  }

  // Resolve the target type's config (caps + bed/price rules) by probing with
  // the target type id, then validate the current occupancy fits.
  const probe: AllocationRoom = { ...room, roomTypeId: target.roomTypeId, roomTypeName: target.name, basePrice: target.basePrice };
  const cfg = resolveCfg(probe);
  if (room.adults > cfg.maxAdults) {
    return { ok: false, outOfRange: false, reason: `${target.name} rooms hold at most ${cfg.maxAdults} adult${cfg.maxAdults === 1 ? "" : "s"}.` };
  }
  if (room.children > cfg.maxChildren) {
    return { ok: false, outOfRange: false, reason: `${target.name} rooms hold at most ${cfg.maxChildren} child${cfg.maxChildren === 1 ? "" : "ren"}.` };
  }

  const extraBed = room.adults > cfg.baseAdults && cfg.allowExtraBed;
  const p = computeRoomPricing(target.basePrice, room.adults, extraBed, room.nights, cfg);
  const changed: AllocationRoom = {
    ...room,
    roomTypeId:    target.roomTypeId,
    roomTypeName:  target.name,
    basePrice:     target.basePrice,
    extraBed,
    extraAdultCost: p.extraAdultCost,
    extraBedCost:   p.extraBedCost,
    childAgeLimit:  cfg.childAgeLimit,
    pricePerNight:  p.pricePerNight,
    totalPrice:     p.totalPrice,
  };
  return { ok: true, rooms: rooms.map((r, i) => (i === roomIndex ? changed : r)) };
}

// ── Formatting ────────────────────────────────────────────────────────────────

const DIVIDER = "━━━━━━━━━━━━━━━━";

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

/**
 * Extract children's ages from free-form guest text. Pulls every integer
 * sequence and keeps those in the child range 0–17, preserving order.
 * Pure + exported for unit testing. Examples:
 *   "6, 9" → [6, 9]   "6 and 9 years" → [6, 9]   "20, 5" → [5]   "no kids" → []
 */
export function parseChildrenAges(raw: string): number[] {
  const matches = raw.match(/\d+/g);
  if (!matches) return [];
  return matches
    .map((m) => parseInt(m, 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 17);
}

/** Join ages for display: [6,9] → "6 & 9", [4,7,12] → "4, 7 & 12". */
function formatAges(ages: number[]): string {
  if (ages.length <= 1) return ages.join("");
  return `${ages.slice(0, -1).join(", ")} & ${ages[ages.length - 1]}`;
}

export function renderAllocationSummary(
  allocated: AllocationRoom[],
  opts?: { trailing?: string; childrenAges?: number[] | undefined },
): string {
  const childrenAges = opts?.childrenAges ?? [];
  let text = `🛏 *Suggested Allocation*\n${DIVIDER}\n`;
  allocated.forEach((r, i) => {
    // Show ages only when this room's children count matches the ages provided
    // (unambiguous — e.g. a single room holding all the children).
    let childPart = "";
    if (r.children > 0) {
      childPart = childrenAges.length > 0 && r.children === childrenAges.length
        ? `, children aged ${formatAges(childrenAges)}`
        : `, ${r.children} child${r.children > 1 ? "ren" : ""}`;
    }
    text += `*Room ${i + 1}: ${r.roomTypeName}*\n`;
    text += `👥 ${r.adults} adult${r.adults > 1 ? "s" : ""}${childPart}\n`;
    if (r.extraBed) text += `🛏 Extra bed included\n`;

    // Price breakdown — only show the lines that carry a non-zero charge.
    const nightsLine = `${inr(r.pricePerNight)}/night × ${r.nights} night${r.nights > 1 ? "s" : ""} = *${inr(r.totalPrice)}*`;
    const parts: string[] = [];
    if (r.extraAdultCost > 0) parts.push(`${inr(r.extraAdultCost)} extra adult`);
    if (r.extraBedCost   > 0) parts.push(`${inr(r.extraBedCost)} extra bed`);
    if (parts.length > 0) {
      text += `💰 ${inr(r.basePrice)} base + ${parts.join(" + ")}\n   = ${nightsLine}\n`;
    } else {
      text += `💰 ${nightsLine}\n`;
    }
  });
  const total = allocated.reduce((s, r) => s + r.totalPrice, 0);
  text += `${DIVIDER}\n*Total: ${inr(total)}*`;

  // Informational age-limit note (childAgeLimit is display-only — no automatic
  // reclassification, since guest input does not include individual ages).
  const ageLimit = allocated.find((r) => r.childAgeLimit != null)?.childAgeLimit;
  if (ageLimit != null) {
    text += `\n_Note: Children above ${ageLimit} years are charged as adults._`;
  }

  if (opts?.trailing) text += `\n\n${opts.trailing}`;
  return text;
}

function confirmPromptFooter(): string {
  return "Reply *1* to Confirm\nReply *2* to Modify manually\nReply *MENU* to cancel";
}

function buildManualRoomList(rooms: AllocationRoomInput[], remaining: { adults: number; children: number }): string {
  let text = `Pick a room to add to your booking. *${remaining.adults} adult${remaining.adults === 1 ? "" : "s"}` +
    (remaining.children > 0 ? `, ${remaining.children} child${remaining.children > 1 ? "ren" : ""}` : "") +
    `* still need a room.\n\n${DIVIDER}\n`;
  rooms.forEach((r, i) => {
    const cap: string[] = [];
    if (r.maxAdults != null) cap.push(`${r.maxAdults} adults`);
    if (r.maxChildren != null && r.maxChildren > 0) cap.push(`${r.maxChildren} child`);
    const capPart = cap.length ? ` _(fits ${cap.join(", ")})_` : "";
    const availPart = ` _(${r.availableCount} avail)_`;
    text += `*${i + 1}.* ${r.name}${capPart}${availPart} — ${inr(r.basePrice)}/night\n`;
  });
  text += `${DIVIDER}\n\nReply *1–${rooms.length}* to add a room.\nReply *DONE* when finished.\nReply *MENU* to cancel.`;
  return text;
}

/** Room types the guest can still add: availableCount minus what's already
 *  selected of that type, > 0. Used for the optional "add another room" list. */
function addableRooms(rooms: AllocationRoomInput[], selected: AllocationRoom[]): AllocationRoomInput[] {
  return rooms.filter((r) => {
    const picked = selected.filter((s) => s.roomTypeId === r.roomTypeId).length;
    return r.availableCount - picked > 0;
  });
}

/** Room-type capacity hint, e.g. " _(fits 3 adults, 1 child)_". */
function capHint(r: { maxAdults: number | null; maxChildren: number | null }): string {
  const cap: string[] = [];
  if (r.maxAdults != null) cap.push(`${r.maxAdults} adults`);
  if (r.maxChildren != null && r.maxChildren > 0) cap.push(`${r.maxChildren} child`);
  return cap.length ? ` _(fits ${cap.join(", ")})_` : "";
}

/** Occupancy phrase for a room, e.g. "2 adults, 1 child, extra bed". */
function occupancyPhrase(room: AllocationRoom): string {
  const parts = [`${room.adults} adult${room.adults === 1 ? "" : "s"}`];
  if (room.children > 0) parts.push(`${room.children} child${room.children > 1 ? "ren" : ""}`);
  if (room.extraBed) parts.push("extra bed");
  return parts.join(", ");
}

// ── Structured-modify menu (deterministic, AI-free) ──────────────────────────

export type RoomAction = "add_bed" | "remove_bed" | "move_guest" | "change_type" | "remove_room";

/**
 * The actions offered for a room, in fixed order. Pure function of the room +
 * its config, so render and handler derive the SAME numbered list without
 * storing the mapping in state. `change_type` is offered unconditionally (kept
 * stable across turns — whether other types are actually available is checked
 * when the guest enters the change-type picker, not here).
 */
export function roomMenuOptions(room: AllocationRoom, cfg: AllocationConfig): RoomAction[] {
  const opts: RoomAction[] = [];
  if (cfg.allowExtraBed && !room.extraBed) opts.push("add_bed");
  if (room.extraBed)                       opts.push("remove_bed");
  if (room.adults > 0 || room.children > 0) opts.push("move_guest");
  opts.push("change_type");
  opts.push("remove_room");
  return opts;
}

const ROOM_ACTION_LABELS: Record<RoomAction, string> = {
  add_bed:     "Add extra bed",
  remove_bed:  "Remove extra bed",
  move_guest:  "Move a guest out",
  change_type: "Change room type",
  remove_room: "Remove this room",
};

/**
 * Manual-mode prompt: existing rooms are editable (numbered 1..N), with an
 * OPTIONAL add-room list numbered AFTER them (N+1..N+M). Fully navigable with
 * no AI. When nothing is addable, only the edit list + DONE/MENU are shown.
 */
export function renderManualMode(state: AraState, addable: AllocationRoomInput[]): string {
  const n = state.selectedRooms.length;
  let text = `✏️ *Modify your booking*\n${DIVIDER}\n`;
  state.selectedRooms.forEach((r, i) => {
    text += `*Room ${i + 1}: ${r.roomTypeName}* — ${occupancyPhrase(r)} — ${inr(r.totalPrice)}\n`;
  });
  const total = state.selectedRooms.reduce((s, r) => s + r.totalPrice, 0);
  text += `${DIVIDER}\n*Total: ${inr(total)}*\n`;
  if (n > 0) text += `\nReply *1–${n}* to edit a room.\n`;
  if (addable.length > 0) {
    text += `\n➕ *Add a room:*\n`;
    addable.forEach((r, i) => {
      text += `*${n + i + 1}.* ${r.name}${capHint(r)} _(${r.availableCount} avail)_ — ${inr(r.basePrice)}/night\n`;
    });
  }
  text += `\nReply *DONE* to confirm · *MENU* to cancel`;
  return text;
}

/** Per-room action menu (room_menu phase). */
export function renderRoomMenu(room: AllocationRoom, options: RoomAction[], roomIndex: number): string {
  let text = `*Room ${roomIndex + 1}: ${room.roomTypeName}*\n👥 ${occupancyPhrase(room)}\n💰 ${inr(room.pricePerNight)}/night\n\nWhat would you like to do?\n${DIVIDER}\n`;
  options.forEach((a, i) => { text += `*${i + 1}.* ${ROOM_ACTION_LABELS[a]}\n`; });
  text += `${DIVIDER}\nReply *0* to go back · *MENU* to cancel`;
  return text;
}

/** "How many to move out" prompt (move_from_count phase). */
export function renderMoveFromCount(room: AllocationRoom, roomIndex: number): string {
  return `Moving guests out of *Room ${roomIndex + 1}: ${room.roomTypeName}*\n` +
    `(currently ${room.adults} adult${room.adults === 1 ? "" : "s"}, ${room.children} child${room.children === 1 ? "" : "ren"})\n\n` +
    `How many adults and children to move?\n` +
    `Format: *adults children*  e.g. *1 0* for 1 adult, 0 children.\n` +
    `Reply *0* to go back · *MENU* to cancel.`;
}

/** Destination picker (move_to_room phase). Lists every room except the source,
 *  numbered 1.. in display order, with current occupancy + caps. */
export function renderMoveToRoom(
  state: AraState,
  pending: { adults: number; children: number },
  fromIndex: number,
  resolveCfg: RoomConfigResolver,
): string {
  const moving: string[] = [];
  if (pending.adults > 0)   moving.push(`${pending.adults} adult${pending.adults === 1 ? "" : "s"}`);
  if (pending.children > 0) moving.push(`${pending.children} child${pending.children > 1 ? "ren" : ""}`);
  let text = `Move ${moving.join(", ")} to which room?\n${DIVIDER}\n`;
  let n = 0;
  state.selectedRooms.forEach((r, i) => {
    if (i === fromIndex) return;
    n++;
    const cfg = resolveCfg(r);
    text += `*${n}.* ${r.roomTypeName} — currently ${r.adults} adults, ${r.children} child (max ${cfg.maxAdults} adults, ${cfg.maxChildren} child)\n`;
  });
  text += `${DIVIDER}\nReply *0* to go back · *MENU* to cancel.`;
  return text;
}

/** Room types the room can switch to: every type except its current one. Catalog-
 *  based (stable ordering across turns); availability is validated on apply. */
function changeTypeCandidates(rooms: AllocationRoomInput[], current: AllocationRoom): AllocationRoomInput[] {
  return rooms.filter((r) => r.roomTypeId !== current.roomTypeId);
}

/** New-room-type picker (change_type_select phase). */
export function renderChangeTypeSelect(room: AllocationRoom, candidates: AllocationRoomInput[], roomIndex: number): string {
  let text = `Change *Room ${roomIndex + 1}: ${room.roomTypeName}* (currently ${occupancyPhrase(room)}) to which type?\n${DIVIDER}\n`;
  candidates.forEach((r, i) => {
    text += `*${i + 1}.* ${r.name}${capHint(r)} _(${r.availableCount} avail)_ — ${inr(r.basePrice)}/night\n`;
  });
  text += `${DIVIDER}\nReply *0* to go back · *MENU* to cancel.`;
  return text;
}

/** Primary room-type name for a plan ("Deluxe" or "Deluxe mix" for mixed types). */
function planTypeName(plan: AllocationPlan): string {
  const primary = plan.rooms.find((r) => r.roomTypeId === plan.primaryRoomTypeId) ?? plan.rooms[0];
  const name    = primary?.roomTypeName ?? "Room";
  const allSame = plan.rooms.length > 0 && plan.rooms.every((r) => r.roomTypeId === plan.primaryRoomTypeId);
  return allSame ? name : `${name} mix`;
}

/** Text fallback when the carousel can't be sent (or only 2 plans). Pure. */
export function renderPlanTextFallback(plans: AllocationPlan[]): string {
  let text = `🏨 *Choose your room plan:*\n${DIVIDER}\n`;
  plans.forEach((p, i) => {
    const beds = p.extraBedCount > 0 ? "Extra beds incl." : "No extra beds";
    text += `*${i + 1}. ${p.label} — ${inr(p.totalPrice)}*\n`;
    text += `   ${p.roomCount} room${p.roomCount === 1 ? "" : "s"} · ${planTypeName(p)} · ${beds}\n`;
    p.rooms.forEach((r, j) => {
      text += `   Room ${j + 1}: ${r.roomTypeName} — ${occupancyPhrase(r)}\n`;
    });
  });
  text += `${DIVIDER}\nReply *1–${plans.length}* to choose · *MENU* to cancel`;
  return text;
}

// ── Output contract ───────────────────────────────────────────────────────────

/**
 * Writes the canonical booking output keys into flowVars. Guarded by the
 * presence of bookingRooms — never overwrites an already-confirmed payload.
 * Returns true if it wrote, false if it was a no-op (idempotency).
 */
function writeOutputContract(flowVars: Record<string, string>, allocated: AllocationRoom[]): boolean {
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
  return true;
}

// ── Date helpers (UTC, mirrors availability.service style) ────────────────────

function countNights(checkIn: string, checkOut: string): number {
  const ci = Date.parse(`${checkIn}T00:00:00Z`);
  const co = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(ci) || !Number.isFinite(co) || co <= ci) return 0;
  return Math.round((co - ci) / 86_400_000);
}

// ── Dependency contract ───────────────────────────────────────────────────────

export type Adjacency = Map<string, { targetId: string; sourceHandle: string | null | undefined }[]>;

export type FetchRoomTypesFn = (
  hotelId: string,
  filters?: { minCapacity?: number; minAdults?: number; minChildren?: number },
) => Promise<Array<{
  id:           string;
  name:         string;
  basePrice:    number;
  capacity:     number | null;
  maxAdults:    number | null;
  maxChildren:  number | null;
  description?: string | null;
  baseAdults?:       number | null;
  baseChildren?:     number | null;
  extraAdultCharge?: number | null;
  allowExtraBed?:    boolean | null;
  extraBedCharge?:   number | null;
  childAgeLimit?:    number | null;
}>>;

export type GetCalendarDataFn = (
  hotelId: string,
  startDate: string,
  endDate: string,
) => Promise<{
  roomTypes: Array<{ id: string; name: string; basePrice: number; totalRooms: number }>;
  dates:     string[];
  cells:     Record<string, Record<string, { availableRooms: number }>>;
}>;

type FlowData = {
  flowId:      string;
  flowVars:    Record<string, string>;
  waitingFor?: "answer";
  lastInput?:  string;
};

export type AdvancedRoomAllocationDeps = {
  node:           SerializedFlowNode;
  currentNodeId:  string;
  hotelId:        string;
  guestId:        string;
  flowId:         string;
  flowData:       FlowData;
  sessionData:    SessionData;
  input:          string;
  adjacency:      Adjacency;
  advance:        (currentNodeId: string) => Promise<string | null>;
  nextNodeId:     (nodeId: string, adjacency: Adjacency, handle?: string) => string | null;
  updateSession:  (guestId: string, hotelId: string, state: string, data: SessionData) => Promise<unknown>;
  resetSession:   (guestId: string, hotelId: string) => Promise<unknown>;
  safeMenu:       (hotelId: string) => Promise<string | null>;
  fetchRoomTypes: FetchRoomTypesFn;
  getCalendarData: GetCalendarDataFn;
  // OPTIONAL — when provided, manual mode uses it as a fallback to interpret
  // free-text edits that structured parsing can't. Absent → no AI fallback
  // (manual mode behaves exactly as before).
  interpretModification?: InterpretModificationFn;
  // OPTIONAL — sends the Phase-1 multi-plan interactive list. Absent → Phase 1
  // falls back to the text plan list even when multiple plans exist.
  sendPlanList?: SendPlanListFn;
  // OPTIONAL — sends the room-type carousel that precedes the plan list.
  // Absent → carousel step is skipped silently.
  sendRoomCarousel?: SendRoomCarouselFn;
};

/** Sends the multi-plan interactive list; returns true if sent (→ "ALREADY_SENT"). */
export type SendPlanListFn = (args: {
  hotelId:             string;
  guestId:             string;
  plans:               AllocationPlan[];
  eligibleRoomInputs?: AllocationRoomInput[];
}) => Promise<boolean>;

/** Sends the room-type carousel that precedes the plan list. Returns true if sent. */
export type SendRoomCarouselFn = (args: {
  hotelId:    string;
  guestId:    string;
  roomInputs: AllocationRoomInput[];
  adults:     number;
}) => Promise<boolean>;

/** Free-text → one structured allocation-edit op. Mirrors ai.service. */
export type InterpretModificationFn = (
  currentRooms: Array<{
    index:        number;
    roomTypeName: string;
    adults:       number;
    children:     number;
    extraBed:     boolean;
  }>,
  guestMessage: string,
) => Promise<{
  operation: "add_extra_bed" | "remove_extra_bed" | "move_extra_bed" | "remove_room" | "move_guest" | "unknown";
  roomIndex?:     number;
  fromRoomIndex?: number;
  toRoomIndex?:   number;
  adults?:        number;
  children?:      number;
  confidence: "high" | "low";
}>;

// ── Config + flowVar parsing ──────────────────────────────────────────────────

function resolveConfig(data: AdvancedRoomAllocationNodeData): AllocationConfig {
  return {
    baseAdults:       data.baseAdults       ?? 2,
    baseChildren:     data.baseChildren     ?? 0,
    maxAdults:        data.maxAdults        ?? 3,
    maxChildren:      data.maxChildren      ?? 1,
    extraAdultCharge: data.extraAdultCharge ?? 0,
    allowExtraBed:    data.allowExtraBed    ?? false,
    extraBedCharge:   data.extraBedCharge   ?? 0,
    childAgeLimit:    data.childAgeLimit    ?? null,
  };
}

// ── Inventory-aware room list builder ────────────────────────────────────────

async function buildInventoryRooms(
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
      baseAdults:       r.baseAdults       ?? null,
      baseChildren:     r.baseChildren     ?? null,
      extraAdultCharge: r.extraAdultCharge ?? null,
      allowExtraBed:    r.allowExtraBed    ?? null,
      extraBedCharge:   r.extraBedCharge   ?? null,
      childAgeLimit:    r.childAgeLimit    ?? null,
    };
  });
}

// ── State helpers ─────────────────────────────────────────────────────────────

const ARA_KEY = "__araState__";

function readState(flowVars: Record<string, string>): AraState | null {
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

function writeState(flowVars: Record<string, string>, state: AraState): void {
  flowVars[ARA_KEY] = JSON.stringify(state);
}

function clearState(flowVars: Record<string, string>): void {
  delete flowVars[ARA_KEY];
}

async function persist(deps: AdvancedRoomAllocationDeps): Promise<void> {
  const { guestId, hotelId, flowId, currentNodeId, sessionData, flowData, updateSession } = deps;
  await updateSession(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, {
    ...sessionData,
    flow: { ...flowData },
  });
}

// ── Phase 1 ───────────────────────────────────────────────────────────────────

async function phase1(deps: AdvancedRoomAllocationDeps): Promise<string | null> {
  const { node, hotelId, guestId, flowData, fetchRoomTypes, getCalendarData, resetSession } = deps;
  const vars = flowData.flowVars;
  const data = (node.data ?? {}) as AdvancedRoomAllocationNodeData;
  const config = resolveConfig(data);

  // ── Idempotency guard (rule 1): if araState already exists, re-render rather
  // than re-running the allocator (would risk a different outcome if availability
  // shifted in the milliseconds between webhook retries).
  const existing = readState(vars);
  if (existing) {
    flowData.waitingFor = "answer";
    await persist(deps);
    // Mid plan-selection (webhook retry) → re-show the TEXT list, never re-send
    // the carousel (avoids a double-send).
    if (existing.phase === "plan_selection" && existing.plans && existing.plans.length > 0) {
      return renderPlanTextFallback(existing.plans);
    }
    return renderAllocationSummary(existing.selectedRooms, { trailing: confirmPromptFooter(), childrenAges: existing.guests.childrenAges });
  }

  // Date inputs are mandatory; let an earlier date question collect them.
  const checkIn  = vars["bookingCheckIn"];
  const checkOut = vars["bookingCheckOut"];
  if (!checkIn || !checkOut) {
    await resetSession(guestId, hotelId);
    return "I don't have your check-in / check-out dates yet. Please start over from the main menu.";
  }

  const nights = countNights(checkIn, checkOut);
  if (nights <= 0) {
    await resetSession(guestId, hotelId);
    return "Check-out must be after check-in. Please start over from the main menu.";
  }

  // Guest counts come from configurable flowVars (set on the node), falling back
  // to the historical bookingAdults / bookingChildren names + "2" / "0" defaults.
  const adultsVarName   = data.adultsVar   || "bookingAdults";
  const childrenVarName = data.childrenVar || "bookingChildren";

  const adults   = parseInt(vars[adultsVarName]   ?? "2", 10) || 2;
  const children = parseInt(vars[childrenVarName] ?? "0", 10) || 0;

  let childrenAges: number[] = [];
  const agesVarName = data.childrenAgesVar || "";
  if (agesVarName && vars[agesVarName]) {
    childrenAges = parseChildrenAges(vars[agesVarName]);
  }

  if (adults + children === 0) {
    await resetSession(guestId, hotelId);
    return "I need at least one guest to allocate a room. Please start over from the main menu.";
  }

  const roomInputs = await buildInventoryRooms(hotelId, checkIn, checkOut, fetchRoomTypes, getCalendarData);
  const plans = generatePlans({ adults, children, rooms: roomInputs, config, nights });

  if (plans.length === 0) {
    await resetSession(guestId, hotelId);
    return `Sorry, we don't have enough rooms for ${adults + children} guests on those dates. Please contact us directly or try different dates.`;
    // ↑ Spec-mandated graceful failure (step 3 inventory-exhaustion path).
  }

  const guestsField = { adults, children, ...(childrenAges.length > 0 ? { childrenAges } : {}) };

  // Single unique plan → existing single-summary confirm flow (no carousel).
  if (plans.length === 1) {
    const only = plans[0]!;
    const newState: AraState = {
      guests:          guestsField,
      selectedRooms:   only.rooms,
      remainingGuests: { adults: 0, children: 0 },
      phase:           "confirm",
    };
    writeState(vars, newState);
    flowData.waitingFor = "answer";
    await persist(deps);
    return renderAllocationSummary(only.rooms, { trailing: confirmPromptFooter(), childrenAges });
  }

  // 2–3 plans → plan_selection: store plans + eligible room types, offer carousel
  // then plan list (fall back to text when deps absent).
  const planState: AraState = {
    guests:          guestsField,
    selectedRooms:   [],
    remainingGuests: { adults: 0, children: 0 },
    phase:           "plan_selection",
    plans,
    eligibleRoomInputs: roomInputs,
  };
  writeState(vars, planState);
  flowData.waitingFor = "answer";
  await persist(deps);

  // Message 1 — room type carousel (fire-and-forget on failure; plan list still follows)
  if (deps.sendRoomCarousel) {
    await deps.sendRoomCarousel({ hotelId, guestId, roomInputs, adults });
  }

  // Message 2 — plan list
  if (deps.sendPlanList) {
    const sent = await deps.sendPlanList({ hotelId, guestId, plans, eligibleRoomInputs: roomInputs });
    if (sent) return "ALREADY_SENT";
  }
  return renderPlanTextFallback(plans);
}

// ── Phase 2 helpers ───────────────────────────────────────────────────────────

function isConfirmInput(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  return s === "1" || s === "confirm";
}
function isModifyInput(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  return s === "2" || s === "modify";
}
function isMenuInput(raw: string): boolean {
  return raw.trim().toUpperCase() === "MENU";
}
function isDoneInput(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  return s === "done" || s === "confirm";
}

async function finalizeAndAdvance(deps: AdvancedRoomAllocationDeps, allocated: AllocationRoom[]): Promise<string | null> {
  const { flowData, currentNodeId, adjacency, nextNodeId, advance, guestId, hotelId, resetSession, safeMenu } = deps;
  // Output contract write is guarded by !bookingRooms inside writeOutputContract.
  writeOutputContract(flowData.flowVars, allocated);
  clearState(flowData.flowVars);
  delete flowData.waitingFor;

  const next = nextNodeId(currentNodeId, adjacency);
  if (!next) {
    // No downstream node — booking can't progress. Best-effort: reset and show menu.
    await resetSession(guestId, hotelId);
    return safeMenu(hotelId);
  }
  // Don't persist here — the recursive advance call will re-save under the
  // new node's state. Persisting twice would race with the downstream save.
  return advance(next);
}

// ── Manual-mode AI fallback ───────────────────────────────────────────────────

const MODIFY_PROMPT = "Reply *DONE* to confirm, a room number to modify, or *MENU* to cancel.";
const MODIFY_FAILED = "I couldn't make that change automatically.";

type ModifyPhase = "confirm" | "manual";

/** Render the allocation followed by the prompt for the current phase. */
function renderWithPrompt(phase: ModifyPhase, st: AraState): string {
  if (phase === "confirm") {
    return renderAllocationSummary(st.selectedRooms, { trailing: confirmPromptFooter(), childrenAges: st.guests.childrenAges });
  }
  return `${renderAllocationSummary(st.selectedRooms, { childrenAges: st.guests.childrenAges })}\n\n${MODIFY_PROMPT}`;
}

/** The phase's existing (no-change) re-prompt — what the guest sees when nothing was applied. */
function existingReprompt(phase: ModifyPhase, st: AraState, roomInputs: AllocationRoomInput[]): string {
  if (phase === "confirm") {
    return `Please reply *1* to confirm, *2* to modify, or *MENU* to cancel.\n\n${renderAllocationSummary(st.selectedRooms, { childrenAges: st.guests.childrenAges })}`;
  }
  return `Please reply with a room number (1–${roomInputs.length}), *DONE* to finish, or *MENU* to cancel.`;
}

/**
 * Phase-aware fallback for free text that structured parsing couldn't match.
 * Runs in BOTH confirm and manual phases. Returns the reply string, or `null`
 * ONLY when there is no interpreter dep (caller keeps its exact current
 * behaviour). The AI only chooses an operation + indices + counts; this
 * function validates everything, applies the change deterministically (prices
 * recomputed here, never by the AI), persists with the SAME phase, and
 * re-renders. On unknown / low-confidence / out-of-range it acknowledges the
 * miss and re-prompts — it never silently guesses or applies.
 */
async function tryModify(
  deps:       AdvancedRoomAllocationDeps,
  state:      AraState,
  roomInputs: AllocationRoomInput[],
  input:      string,
  phase:      ModifyPhase,
): Promise<string | null> {
  if (!deps.interpretModification) return null;

  const currentRooms = state.selectedRooms.map((r, index) => ({
    index,
    roomTypeName: r.roomTypeName,
    adults:       r.adults,
    children:     r.children,
    extraBed:     r.extraBed,
  }));

  const ai = await deps.interpretModification(currentRooms, input);

  // Acknowledge + re-prompt without changing anything (Fix A).
  const ackReprompt = (): string => `${MODIFY_FAILED}\n\n${existingReprompt(phase, state, roomInputs)}`;

  // Never guess.
  if (ai.operation === "unknown" || ai.confidence === "low") return ackReprompt();

  // Per-room config resolver from live inventory (DB overrides → node config).
  const nodeConfig = resolveConfig((deps.node.data ?? {}) as AdvancedRoomAllocationNodeData);
  const inputById  = new Map(roomInputs.map((ri) => [ri.roomTypeId, ri]));
  const resolveCfg: RoomConfigResolver = (ar) => {
    const ri = inputById.get(ar.roomTypeId);
    return ri ? resolveRoomConfig(ri, nodeConfig) : nodeConfig;
  };

  let applied: ApplyResult;
  switch (ai.operation) {
    case "add_extra_bed":
      applied = applyAddExtraBed(state.selectedRooms, ai.roomIndex ?? -1, resolveCfg);
      break;
    case "remove_extra_bed":
      applied = applyRemoveExtraBed(state.selectedRooms, ai.roomIndex ?? -1);
      break;
    case "move_extra_bed":
      applied = applyMoveExtraBed(state.selectedRooms, ai.fromRoomIndex ?? -1, ai.toRoomIndex ?? -1, resolveCfg);
      break;
    case "remove_room":
      applied = applyRemoveRoom(state.selectedRooms, ai.roomIndex ?? -1);
      break;
    case "move_guest":
      applied = applyMoveGuest(
        state.selectedRooms, ai.fromRoomIndex ?? -1, ai.toRoomIndex ?? -1, ai.adults ?? 0, ai.children ?? 0, resolveCfg,
      );
      break;
    default:
      return ackReprompt();
  }

  if (!applied.ok) {
    // Out-of-range index behaves like "unknown" → acknowledge + re-prompt.
    if (applied.outOfRange) return ackReprompt();
    // Validation rejection (e.g. cap exceeded) → reason + unchanged allocation.
    return `${applied.reason}\n\n${renderWithPrompt(phase, state)}`;
  }

  const updated: AraState = {
    guests:        state.guests,
    selectedRooms: applied.rooms,
    remainingGuests: applied.returnedGuests
      ? {
          adults:   state.remainingGuests.adults   + applied.returnedGuests.adults,
          children: state.remainingGuests.children + applied.returnedGuests.children,
        }
      : state.remainingGuests,
    phase, // KEEP the current phase — confirm stays confirm, manual stays manual.
  };
  writeState(deps.flowData.flowVars, updated);
  await persist(deps);

  return renderWithPrompt(phase, updated);
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function handleAdvancedRoomAllocation(deps: AdvancedRoomAllocationDeps): Promise<string | null> {
  const { input, flowData, hotelId, guestId, resetSession, safeMenu, currentNodeId, adjacency, nextNodeId, advance } = deps;
  const vars = flowData.flowVars;

  // ── Phase 1 ─────────────────────────────────────────────────────────────────
  if (!flowData.waitingFor) {
    return phase1(deps);
  }

  // ── Phase 2 ─────────────────────────────────────────────────────────────────
  // Global cancel — works in any sub-phase.
  if (isMenuInput(input)) {
    clearState(vars);
    await resetSession(guestId, hotelId);
    return safeMenu(hotelId);
  }

  const state = readState(vars);

  // ── Idempotency rule 2: confirm arrives after state already cleaned up ─────
  // (e.g. a duplicate webhook after the first confirm already advanced past us)
  if (!state) {
    if (isConfirmInput(input)) {
      // Already confirmed and cleaned up. If output keys exist, this is a true
      // duplicate — silently no-op. If not, do a safe silent advance without
      // re-writing any keys.
      if (vars["bookingRooms"]) return null;
      delete flowData.waitingFor;
      const next = nextNodeId(currentNodeId, adjacency);
      if (!next) {
        await resetSession(guestId, hotelId);
        return safeMenu(hotelId);
      }
      return advance(next);
    }
    // No state and not a confirm-like input → reset gracefully.
    await resetSession(guestId, hotelId);
    return safeMenu(hotelId);
  }

  // ── Plan selection sub-phase ───────────────────────────────────────────────
  // (MENU is already handled globally above.)
  if (state.phase === "plan_selection") {
    const plans = state.plans ?? [];
    if (plans.length === 0) {            // corrupt state → reset gracefully
      clearState(vars);
      await resetSession(guestId, hotelId);
      return safeMenu(hotelId);
    }

    const t = input.trim();

    // ── Single room-type selection: carousel button ("room_{id}") or list row ("ROOM_TYPE:{id}") ──
    // When a guest taps a carousel card or picks from Section 2 of the plan list, we
    // run allocateRooms restricted to that single type and jump straight to confirm.
    const roomTypeIdFromButton = t.match(/^room_TYPE:(.+)$/i)?.[1]    // list row id
                              ?? t.match(/^ROOM_TYPE:(.+)$/i)?.[1];   // text fallback
    if (roomTypeIdFromButton) {
      const eligible = state.eligibleRoomInputs ?? [];
      const single   = eligible.filter((r) => r.roomTypeId === roomTypeIdFromButton);
      if (single.length > 0) {
        const nodeConfig = resolveConfig((deps.node.data ?? {}) as AdvancedRoomAllocationNodeData);
        const nights     = countNights(deps.flowData.flowVars["bookingCheckIn"] ?? "", deps.flowData.flowVars["bookingCheckOut"] ?? "");
        const singlePlan = allocateRooms({ adults: state.guests.adults, children: state.guests.children, rooms: single, config: nodeConfig, nights });
        if (singlePlan && singlePlan.length > 0) {
          const confirmState: AraState = {
            guests:          state.guests,
            selectedRooms:   singlePlan,
            remainingGuests: { adults: 0, children: 0 },
            phase:           "confirm",
          };
          writeState(vars, confirmState);
          await persist(deps);
          return renderAllocationSummary(singlePlan, { trailing: confirmPromptFooter(), childrenAges: state.guests.childrenAges });
        }
        // allocateRooms returned null — that room type can't house the guests on those dates
        const typeName = single[0]?.name ?? "That room type";
        return `Sorry, *${typeName}* is not available for your selected dates. Please choose another option.\n\n${renderPlanTextFallback(plans)}`;
      }
      // Room type id not found in state — re-show the list
      return renderPlanTextFallback(plans);
    }

    // ── Recommended-plan selection: "plan_N" (0-based) or text "1".."N" ──
    let idx = -1;
    const m = t.match(/^plan_(\d+)$/i);
    if (m) {
      idx = parseInt(m[1]!, 10);
    } else {
      const num = parseInt(t, 10);
      if (Number.isFinite(num)) idx = num - 1;
    }

    if (idx < 0 || idx >= plans.length) {
      // Invalid / unknown → re-show the TEXT list (never re-send the carousel). No mutation.
      return renderPlanTextFallback(plans);
    }

    const chosen = plans[idx]!;
    const confirmState: AraState = {
      guests:            state.guests,
      selectedRooms:     chosen.rooms,
      remainingGuests:   { adults: 0, children: 0 },
      phase:             "confirm",
      selectedPlanIndex: idx,
    };
    writeState(vars, confirmState);
    await persist(deps);
    return renderAllocationSummary(chosen.rooms, { trailing: confirmPromptFooter(), childrenAges: state.guests.childrenAges });
  }

  // ── Confirm sub-phase ──────────────────────────────────────────────────────
  if (state.phase === "confirm") {
    if (isConfirmInput(input)) {
      return finalizeAndAdvance(deps, state.selectedRooms);
    }
    if (isModifyInput(input)) {
      // Switch to manual mode but KEEP the suggested rooms as the starting point
      // (all guests already placed). The guest can add/remove rooms, move guests,
      // or DONE to confirm as-is — no rebuild from zero.
      const next: AraState = {
        guests:          state.guests,
        selectedRooms:   state.selectedRooms,
        remainingGuests: { adults: 0, children: 0 },
        phase:           "manual",
      };
      writeState(vars, next);
      await persist(deps);

      // Re-fetch room inputs so the add-room prompt has live availability info.
      const checkIn  = vars["bookingCheckIn"]!;
      const checkOut = vars["bookingCheckOut"]!;
      const rooms = await buildInventoryRooms(hotelId, checkIn, checkOut, deps.fetchRoomTypes, deps.getCalendarData);
      return renderManualMode(next, addableRooms(rooms, next.selectedRooms));
    }
    // Free text at the confirm step → AI modification, staying in confirm phase
    // (Fix B). No interpreter dep → unchanged behaviour (no AI call, no fetch).
    if (deps.interpretModification) {
      const ci = vars["bookingCheckIn"];
      const co = vars["bookingCheckOut"];
      const roomInputs = ci && co
        ? await buildInventoryRooms(hotelId, ci, co, deps.fetchRoomTypes, deps.getCalendarData)
        : [];
      const aiReply = await tryModify(deps, state, roomInputs, input, "confirm");
      if (aiReply !== null) return aiReply;
    }
    return `Please reply *1* to confirm, *2* to modify, or *MENU* to cancel.\n\n${renderAllocationSummary(state.selectedRooms, { childrenAges: state.guests.childrenAges })}`;
  }

  // ── Manual sub-phase ───────────────────────────────────────────────────────
  // Re-fetch rooms each turn — availability may have shifted; do not cache.
  const checkIn  = vars["bookingCheckIn"];
  const checkOut = vars["bookingCheckOut"];
  if (!checkIn || !checkOut) {
    clearState(vars);
    await resetSession(guestId, hotelId);
    return safeMenu(hotelId);
  }
  const rooms = await buildInventoryRooms(hotelId, checkIn, checkOut, deps.fetchRoomTypes, deps.getCalendarData);
  const data   = (deps.node.data ?? {}) as AdvancedRoomAllocationNodeData;
  const config = resolveConfig(data);
  const nights = countNights(checkIn, checkOut);

  // Per-room config resolver from live inventory (DB overrides → node config) —
  // used by the appliers and the destination caps shown in move_to_room.
  const inputById = new Map(rooms.map((ri) => [ri.roomTypeId, ri]));
  const resolveCfg: RoomConfigResolver = (ar) => {
    const ri = inputById.get(ar.roomTypeId);
    return ri ? resolveRoomConfig(ri, config) : config;
  };

  // Return to manual mode showing the modify menu. (remainingGuests is preserved
  // from `state`; the structured-modify phases only run when all guests are placed.)
  const toManual = async (selectedRooms: AllocationRoom[]): Promise<string> => {
    const m: AraState = {
      guests:          state.guests,
      selectedRooms,
      remainingGuests: state.remainingGuests,
      phase:           "manual",
    };
    writeState(vars, m);
    await persist(deps);
    return renderManualMode(m, addableRooms(rooms, selectedRooms));
  };

  // ── room_menu — per-room action picker (deterministic, no AI) ──────────────
  if (state.phase === "room_menu") {
    const idx = state.selectedRoomIndex ?? -1;
    if (!inRange(state.selectedRooms, idx)) return toManual(state.selectedRooms);
    const targetRoom = state.selectedRooms[idx]!;
    const options    = roomMenuOptions(targetRoom, resolveCfg(targetRoom));
    const t = input.trim();
    if (t === "0") return toManual(state.selectedRooms);
    const sel = parseInt(t, 10);
    if (!Number.isFinite(sel) || sel < 1 || sel > options.length) {
      return `Please reply 1–${options.length} or 0 to go back.\n\n${renderRoomMenu(targetRoom, options, idx)}`;
    }
    const action = options[sel - 1]!;
    if (action === "move_guest") {
      const mv: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "move_from_count", selectedRoomIndex: idx,
      };
      writeState(vars, mv);
      await persist(deps);
      return renderMoveFromCount(targetRoom, idx);
    }
    if (action === "change_type") {
      const candidates = changeTypeCandidates(rooms, targetRoom);
      if (candidates.length === 0) {
        return `Sorry, there are no other room types to switch to.\n\n${renderRoomMenu(targetRoom, options, idx)}`;
      }
      const ct: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "change_type_select", selectedRoomIndex: idx,
      };
      writeState(vars, ct);
      await persist(deps);
      return renderChangeTypeSelect(targetRoom, candidates, idx);
    }
    const res: ApplyResult =
      action === "add_bed"    ? applyAddExtraBed(state.selectedRooms, idx, resolveCfg)
      : action === "remove_bed" ? applyRemoveExtraBed(state.selectedRooms, idx)
      : /* remove_room */         applyRemoveRoom(state.selectedRooms, idx);
    if (res.ok) return toManual(res.rooms);
    const reason = res.reason || "Sorry, that didn't work. Please choose another option.";
    return `${reason}\n\n${renderRoomMenu(targetRoom, options, idx)}`;
  }

  // ── move_from_count — how many adults/children to move out ─────────────────
  if (state.phase === "move_from_count") {
    const idx = state.selectedRoomIndex ?? -1;
    if (!inRange(state.selectedRooms, idx)) return toManual(state.selectedRooms);
    const targetRoom = state.selectedRooms[idx]!;
    const t = input.trim();
    if (t === "0") {
      const rm: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "room_menu", selectedRoomIndex: idx,
      };
      writeState(vars, rm);
      await persist(deps);
      return renderRoomMenu(targetRoom, roomMenuOptions(targetRoom, resolveCfg(targetRoom)), idx);
    }
    const nums = t.split(/\s+/).map((s) => parseInt(s, 10));
    const mvA = Number.isFinite(nums[0]) ? nums[0]! : NaN;
    const mvC = nums.length >= 2 && Number.isFinite(nums[1]) ? nums[1]! : 0;
    if (!Number.isFinite(mvA) || mvA < 0 || mvC < 0 || (mvA === 0 && mvC === 0) ||
        mvA > targetRoom.adults || mvC > targetRoom.children) {
      return `Please reply like *1 0* (adults children) — at least one above 0, and no more than the room has.\n\n${renderMoveFromCount(targetRoom, idx)}`;
    }
    const mv: AraState = {
      guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
      phase: "move_to_room", selectedRoomIndex: idx, pendingMove: { fromRoomIndex: idx, adults: mvA, children: mvC },
    };
    writeState(vars, mv);
    await persist(deps);
    return renderMoveToRoom(mv, mv.pendingMove!, idx, resolveCfg);
  }

  // ── move_to_room — pick the destination room ───────────────────────────────
  if (state.phase === "move_to_room") {
    const pm = state.pendingMove;
    if (!pm || !inRange(state.selectedRooms, pm.fromRoomIndex)) return toManual(state.selectedRooms);
    const fromIdx = pm.fromRoomIndex;
    const t = input.trim();
    if (t === "0") {
      const back: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "move_from_count", selectedRoomIndex: fromIdx, pendingMove: pm, // preserve pendingMove
      };
      writeState(vars, back);
      await persist(deps);
      return renderMoveFromCount(state.selectedRooms[fromIdx]!, fromIdx);
    }
    const destIndices = state.selectedRooms.map((_, i) => i).filter((i) => i !== fromIdx);
    const sel = parseInt(t, 10);
    if (!Number.isFinite(sel) || sel < 1 || sel > destIndices.length) {
      return renderMoveToRoom(state, pm, fromIdx, resolveCfg);
    }
    const toIdx = destIndices[sel - 1]!;
    const res = applyMoveGuest(state.selectedRooms, fromIdx, toIdx, pm.adults, pm.children, resolveCfg);
    if (res.ok) return toManual(res.rooms);
    if (res.outOfRange) return renderMoveToRoom(state, pm, fromIdx, resolveCfg);
    return `${res.reason}\n\n${renderMoveToRoom(state, pm, fromIdx, resolveCfg)}`;
  }

  // ── change_type_select — pick the new room type ────────────────────────────
  if (state.phase === "change_type_select") {
    const idx = state.selectedRoomIndex ?? -1;
    if (!inRange(state.selectedRooms, idx)) return toManual(state.selectedRooms);
    const targetRoom = state.selectedRooms[idx]!;
    const candidates = changeTypeCandidates(rooms, targetRoom);
    const t = input.trim();
    if (t === "0") {
      const rm: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "room_menu", selectedRoomIndex: idx,
      };
      writeState(vars, rm);
      await persist(deps);
      return renderRoomMenu(targetRoom, roomMenuOptions(targetRoom, resolveCfg(targetRoom)), idx);
    }
    const sel = parseInt(t, 10);
    if (!Number.isFinite(sel) || sel < 1 || sel > candidates.length) {
      return renderChangeTypeSelect(targetRoom, candidates, idx);
    }
    const target = candidates[sel - 1]!;
    const res = applyChangeRoomType(state.selectedRooms, idx, target, resolveCfg);
    if (res.ok) return toManual(res.rooms);
    if (res.outOfRange) return renderChangeTypeSelect(targetRoom, candidates, idx);
    return `${res.reason}\n\n${renderChangeTypeSelect(targetRoom, candidates, idx)}`;
  }

  // ── phase "manual" ─────────────────────────────────────────────────────────
  const allPlaced = state.remainingGuests.adults + state.remainingGuests.children === 0;

  if (isDoneInput(input)) {
    if (state.selectedRooms.length === 0) {
      return `You haven't picked any rooms yet. ${buildManualRoomList(rooms, state.remainingGuests)}`;
    }
    return finalizeAndAdvance(deps, state.selectedRooms);
  }

  const pick = parseInt(input.trim(), 10);

  // All guests placed → numbered menu: 1..N edit an existing room (room_menu),
  // N+1..N+M add a room type (offset). Anything else → AI free text, else re-render.
  if (allPlaced) {
    const addable = addableRooms(rooms, state.selectedRooms);
    const n = state.selectedRooms.length;

    if (Number.isFinite(pick) && pick >= 1 && pick <= n) {
      const targetRoom = state.selectedRooms[pick - 1]!;
      const menu: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "room_menu", selectedRoomIndex: pick - 1,
      };
      writeState(vars, menu);
      await persist(deps);
      return renderRoomMenu(targetRoom, roomMenuOptions(targetRoom, resolveCfg(targetRoom)), pick - 1);
    }

    if (Number.isFinite(pick) && pick >= n + 1 && pick <= n + addable.length) {
      const room = addable[pick - n - 1]!;
      const rc   = resolveRoomConfig(room, config);
      const effMaxAdults   = Math.min(config.maxAdults + (config.allowExtraBed ? 1 : 0), room.maxAdults ?? Infinity);
      const effMaxChildren = Math.min(config.maxChildren, room.maxChildren ?? Infinity);
      // Extra room by choice → base occupancy, no extra bed (base never exceeds base).
      const addAdults   = Math.min(rc.baseAdults,   effMaxAdults);
      const addChildren = Math.min(rc.baseChildren, effMaxChildren);
      const p = computeRoomPricing(room.basePrice, addAdults, false, nights, rc);
      const extraRoom: AllocationRoom = {
        roomTypeId:    room.roomTypeId,
        roomTypeName:  room.name,
        adults:        addAdults,
        children:      addChildren,
        extraBed:      false,
        basePrice:     room.basePrice,
        extraAdultCost: p.extraAdultCost,
        extraBedCost:   p.extraBedCost,
        childAgeLimit: rc.childAgeLimit,
        pricePerNight:  p.pricePerNight,
        nights,
        totalPrice:     p.totalPrice,
      };
      return toManual([...state.selectedRooms, extraRoom]);
    }

    // Not a valid menu number → AI free-text convenience, else re-show the menu.
    const aiReply = await tryModify(deps, state, rooms, input, "manual");
    return aiReply ?? renderManualMode(state, addable);
  }

  // ── Guests still need rooms → fill-by-number flow (legacy / rebuild path) ──
  if (!Number.isFinite(pick) || pick < 1 || pick > rooms.length) {
    const aiReply = await tryModify(deps, state, rooms, input, "manual");
    return aiReply ?? `Please reply with a room number (1–${rooms.length}), *DONE* to finish, or *MENU* to cancel.`;
  }
  const room = rooms[pick - 1]!;

  const alreadyPickedOfType = state.selectedRooms.filter((r) => r.roomTypeId === room.roomTypeId).length;
  if (room.availableCount - alreadyPickedOfType <= 0) {
    return `Sorry, no more *${room.name}* rooms available for those dates. Please pick another.`;
  }

  const effMaxAdults   = Math.min(config.maxAdults + (config.allowExtraBed ? 1 : 0), room.maxAdults ?? Infinity);
  const effMaxChildren = Math.min(config.maxChildren, room.maxChildren ?? Infinity);
  const takeAdults     = Math.min(state.remainingGuests.adults,   effMaxAdults);
  const takeChildren   = Math.min(state.remainingGuests.children, effMaxChildren);

  if (takeAdults + takeChildren === 0) {
    return `Sorry, *${room.name}* can't take your remaining guests. Please pick another.\n\n${buildManualRoomList(rooms, state.remainingGuests)}`;
  }

  const rc       = resolveRoomConfig(room, config);
  const extraBed = takeAdults > rc.baseAdults;
  const p        = computeRoomPricing(room.basePrice, takeAdults, extraBed, nights, rc);

  const newRoom: AllocationRoom = {
    roomTypeId:    room.roomTypeId,
    roomTypeName:  room.name,
    adults:        takeAdults,
    children:      takeChildren,
    extraBed,
    basePrice:     room.basePrice,
    extraAdultCost: p.extraAdultCost,
    extraBedCost:   p.extraBedCost,
    childAgeLimit: rc.childAgeLimit,
    pricePerNight:  p.pricePerNight,
    nights,
    totalPrice:     p.totalPrice,
  };

  const updated: AraState = {
    guests:        state.guests,
    selectedRooms: [...state.selectedRooms, newRoom],
    remainingGuests: {
      adults:   state.remainingGuests.adults   - takeAdults,
      children: state.remainingGuests.children - takeChildren,
    },
    phase: "manual",
  };
  writeState(vars, updated);
  await persist(deps);

  if (updated.remainingGuests.adults + updated.remainingGuests.children === 0) {
    return renderManualMode(updated, addableRooms(rooms, updated.selectedRooms));
  }
  const summary = renderAllocationSummary(updated.selectedRooms, { childrenAges: updated.guests.childrenAges });
  return `${summary}\n\n${buildManualRoomList(rooms, updated.remainingGuests)}`;
}
