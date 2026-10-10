/**
 * ara/appliers.ts — pure, never-throwing structured edit operations.
 *
 * Each applier performs ONE validated change to the current selectedRooms and
 * returns the updated list with prices recomputed via computeRoomPricing. All
 * validation lives here, never in the AI: out-of-range indices, disallowed extra
 * beds and over-cap occupancy are REJECTED as values, never thrown.
 */

import { computeRoomPricing } from "./allocator";
import type {
  AllocationConfig,
  AllocationRoom,
  AllocationRoomInput,
  ApplyResult,
  RoomConfigResolver,
} from "./types";

// ── Manual modification (pure, testable appliers) ─────────────────────────────
//
// These apply ONE structured operation (the safe set the AI maps to) to the
// current selectedRooms and return the updated rooms with prices recomputed via
// computeRoomPricing. All validation lives here, not in the AI — out-of-range
// indices and disallowed extra beds are rejected, never thrown.

export function inRange(rooms: AllocationRoom[], i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < rooms.length;
}

/** Reprice a room with an explicit extra-bed flag using the resolved config. */
export function repriceRoom(room: AllocationRoom, extraBed: boolean, cfg: AllocationConfig): AllocationRoom {
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
export function stripExtraBed(room: AllocationRoom): AllocationRoom {
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
export function repriceForMove(room: AllocationRoom, adults: number, children: number, cfg: AllocationConfig): AllocationRoom {
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
