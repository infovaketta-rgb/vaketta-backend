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
  phase:           "collecting_ages" | "collecting_room_preference" | "confirm" | "manual" | "room_menu" | "move_from_count" | "move_to_room" | "change_type_select" | "plan_selection";
  // Structured-modify navigation (all optional — older state shapes stay valid):
  selectedRoomIndex?: number; // which room the guest is editing (room_menu / move_*)
  pendingMove?: { fromRoomIndex: number; adults: number; children: number };
  // Multi-plan selection (Phase 1 carousel):
  plans?:               AllocationPlan[];      // candidate plans offered to the guest
  selectedPlanIndex?:   number;                // which plan the guest chose
  eligibleRoomInputs?:  AllocationRoomInput[]; // room types used to build plans (for single-type selection)
  // Stateful children-age collection (Task 1). Present only during "collecting_ages".
  ageCollection?: {
    adults:        number;   // raw guest counts, carried until ages are done
    children:      number;
    childrenCount: number;   // how many ages we still need (== children)
    collectedAges: number[]; // ages gathered so far across rounds
    rounds:        number;   // accumulation rounds used (each guest reply counts as one)
  };
  // ── Room-preference collection (Piece 2A). Present during
  // "collecting_room_preference"; carries the inputs needed to generate plans
  // once the guest taps a carousel card or "Mix it up". ──
  preferredRoomTypeId?: string | null;     // set on tap; null = "Mix it up"
  selectedPlanType?:    PlanType;          // which plan the guest finally chose
  prefCollection?: {
    adults:   number;
    children: number;
    nights:   number;
    rooms:    AllocationRoomInput[];        // inventory snapshot (avoids re-query)
  };
};

/** Smart-plan classification (Piece 2). */
export type PlanType =
  | "YOUR_CHOICE"
  | "BEST_VALUE"
  | "BEST_EXPERIENCE"
  | "BUDGET_FRIENDLY"
  | "DYNAMIC_EXTRAS";

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
  // ── Smart-plan fields (Piece 2). Optional so the legacy generatePlans path and
  // its tests stay valid; generateSmartPlans always sets all three. ──
  planId?:           string;            // stable per-plan id ("smart_0", …)
  rationale?:        string;            // one-line explanation shown in the list row
  planType?:         PlanType;          // which strategy produced this plan
}

export type AllocationRoomInput = {
  roomTypeId:     string;
  name:           string;
  basePrice:      number;
  maxAdults:      number | null;
  maxChildren:    number | null;
  availableCount: number;
  description?:   string | null; // guest-facing blurb (RoomType.description)
  // Per-room-type occupancy/pricing overrides (DB). Null/undefined → fall back
  // to the node-level config. Allocation caps still use the node config; these
  // only influence the per-room price breakdown.
  baseAdults?:       number | null;
  baseChildren?:     number | null;
  extraAdultCharge?: number | null;
  allowExtraBed?:    boolean | null;
  extraBedCharge?:   number | null;
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

// ── Smart multi-plan generator (Piece 2 — pure, testable) ─────────────────────
//
// Orchestration layer ONLY. Every candidate is produced by the protected
// `allocateRooms` engine; this function just chooses inputs (which room types,
// which strategy) and labels/dedups/ranks the results. The base-first absorb
// algorithm is never modified.

const PLAN_PRIORITY: Record<PlanType, number> = {
  YOUR_CHOICE: 0, BEST_VALUE: 1, BEST_EXPERIENCE: 2, BUDGET_FRIENDLY: 3, DYNAMIC_EXTRAS: 4,
};

/** Composition signature for dedup: sorted "typeId×qty" + total price. */
function planSignature(p: AllocationPlan): string {
  const counts = new Map<string, number>();
  for (const r of p.rooms) counts.set(r.roomTypeId, (counts.get(r.roomTypeId) ?? 0) + 1);
  const comp = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, c]) => `${id}x${c}`).join(",");
  return `${comp}|${p.totalPrice}`;
}

/** True if `p` differs meaningfully from every plan in `existing` (Piece 2 dynamic rule). */
function isDistinctPlan(p: AllocationPlan, existing: AllocationPlan[]): boolean {
  const sig = planSignature(p);
  for (const e of existing) {
    if (planSignature(e) === sig) return false; // identical composition + price
    // ...also treat as duplicate when total price is within 10% AND same room count.
    const diff = e.totalPrice === 0 ? 0 : Math.abs(p.totalPrice - e.totalPrice) / e.totalPrice;
    if (diff <= 0.10 && p.roomCount === e.roomCount) return false;
  }
  return true;
}

/** Cheapest available room type, or undefined when none have inventory. */
function cheapestType(rooms: AllocationRoomInput[]): AllocationRoomInput | undefined {
  return [...rooms].filter((r) => r.availableCount > 0).sort((a, b) => a.basePrice - b.basePrice)[0];
}

type SmartPlanArgs = {
  adults:               number;
  children:             number;
  rooms:                AllocationRoomInput[];
  config:               AllocationConfig;
  nights:               number;
  preferredRoomTypeId?: string | null; // null/undefined = "Mix it up" (no preference)
  maxPlans:             number;        // 1–8
};

/**
 * Preference-aware multi-plan engine. Generates the plan types in priority order,
 * dedups by composition+price (and ±10% price w/ same room count), and trims to
 * maxPlans keeping highest-priority first. Always returns ≥1 plan when anything
 * fits, [] only when nothing houses the party.
 */
export function generateSmartPlans(args: SmartPlanArgs): AllocationPlan[] {
  const { adults, children, rooms, config, nights, preferredRoomTypeId, maxPlans } = args;
  const cap = Math.min(8, Math.max(1, Math.floor(maxPlans) || 4));

  const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const out: AllocationPlan[] = [];

  // Helper: run the engine + wrap as a typed smart plan (or null if it can't fit).
  const make = (
    roomSet: AllocationRoomInput[],
    strategy: "base-first" | "max-fill",
    planType: PlanType,
    label: string,
    rationale: (p: AllocationPlan) => string,
  ): AllocationPlan | null => {
    if (roomSet.length === 0) return null;
    const rooms = allocateRooms({ adults, children, rooms: roomSet, config, nights, strategy });
    if (!rooms || rooms.length === 0) return null;
    const base = toPlan(label, planType === "BEST_VALUE" || planType === "BUDGET_FRIENDLY" ? "value" : planType === "BEST_EXPERIENCE" ? "premium" : "comfort", rooms, nights);
    return { ...base, planType, rationale: rationale(base) };
  };

  // ── YOUR_CHOICE — only when a preference is set. Preferred type for max slots. ──
  if (preferredRoomTypeId) {
    const preferred = rooms.find((r) => r.roomTypeId === preferredRoomTypeId && r.availableCount > 0);
    if (preferred) {
      // Prefer preferred-only (so the whole stay is the requested type). If that
      // can't house everyone, fall back to preferred + the rest (best-effort).
      const yourChoice =
        make([preferred], "base-first", "YOUR_CHOICE", "Your Choice ⭐",
          (p) => `${p.roomCount} ${preferred.name} room${p.roomCount === 1 ? "" : "s"} as requested`)
        ?? make([preferred, ...rooms.filter((r) => r.roomTypeId !== preferredRoomTypeId)], "base-first", "YOUR_CHOICE", "Your Choice ⭐",
          (p) => `Includes your preferred ${preferred.name}`);
      if (yourChoice) out.push(yourChoice);
    }
  }

  // ── BEST_VALUE — cheapest, aggressive extra beds → fewest rooms (max-fill). ──
  const bestValue = make(rooms, "max-fill", "BEST_VALUE", "Best Value 💰",
    (p) => `Fewest rooms — best rate at ${inr(p.totalPrice)}`);
  if (bestValue && isDistinctPlan(bestValue, out)) out.push(bestValue);

  // ── BEST_EXPERIENCE — priciest types, base occupancy (no cramming). ──
  const cheapest = cheapestType(rooms);
  const premiumRooms = cheapest ? rooms.filter((r) => r.roomTypeId !== cheapest.roomTypeId) : rooms;
  const bestExperience = make(premiumRooms.length > 0 ? premiumRooms : rooms, "base-first", "BEST_EXPERIENCE", "Best Experience 🌟",
    (p) => `Most spacious — ${planTypeName(p)} throughout`);
  if (bestExperience && isDistinctPlan(bestExperience, out)) out.push(bestExperience);

  // ── BUDGET_FRIENDLY — uniform cheapest type for all rooms; only if distinct. ──
  if (cheapest) {
    const budget = make([cheapest], "max-fill", "BUDGET_FRIENDLY", "Budget Friendly 🤝",
      (p) => `Best rate — all ${cheapest.name}`);
    if (budget && isDistinctPlan(budget, out)) out.push(budget);
  }

  // ── DYNAMIC_EXTRAS — up to 2 more distinct combos. ──
  let extras = 0;
  const dynamicCandidates: Array<AllocationPlan | null> = [
    make(rooms, "base-first", "DYNAMIC_EXTRAS", "Comfort Pick ✨", (p) => `${p.roomCount} room${p.roomCount === 1 ? "" : "s"}, base occupancy`),
    cheapest ? make(rooms.filter((r) => r.roomTypeId !== cheapest.roomTypeId), "max-fill", "DYNAMIC_EXTRAS", "Premium Value ✨", (p) => `${planTypeName(p)} — ${inr(p.totalPrice)}`) : null,
  ];
  for (const cand of dynamicCandidates) {
    if (extras >= 2) break;
    if (cand && isDistinctPlan(cand, out)) { out.push(cand); extras++; }
  }

  // Trim to maxPlans, keeping highest-priority plan types first.
  out.sort((a, b) => (PLAN_PRIORITY[a.planType!] - PLAN_PRIORITY[b.planType!]) || (a.totalPrice - b.totalPrice));
  const trimmed = out.slice(0, cap);

  // Assign stable ids after trimming.
  trimmed.forEach((p, i) => { p.planId = `smart_${i}`; });
  return trimmed;
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

// ── Stateful children-age collection (Task 1) ─────────────────────────────────

/** Words that hint at relative ages a plain integer regex would misread. */
const AGE_TRIGGER_WORDS = /twins|both|eldest|youngest|same age/i;

/** Max age-collection rounds before we give up and fill remaining slots with 0. */
export const MAX_AGE_ROUNDS = 3;

/**
 * Step 1 of parsing — pull every integer in the child range 0–17 from a reply,
 * preserving order. (Same shape as parseChildrenAges; named for the collection
 * flow where it's the "regex first" step.)
 */
export function extractAgesRegex(reply: string): number[] {
  return parseChildrenAges(reply);
}

/**
 * Whether the AI fallback should be consulted for this reply: only when the
 * regex found NO digits at all, OR the reply uses relative-age words
 * ("twins", "both", "eldest", "youngest", "same age") that the regex misreads.
 */
export function needsAiAgeParse(reply: string): boolean {
  return extractAgesRegex(reply).length === 0 || AGE_TRIGGER_WORDS.test(reply);
}

export type AgeAccumulation = {
  ages:   number[];                          // collected so far (capped at childrenCount)
  status: "complete" | "partial" | "over";   // vs childrenCount
};

/**
 * Append newly-extracted ages to what's been collected and compare against the
 * expected child count. Pure.
 *   - equal  → "complete"
 *   - fewer  → "partial"
 *   - more   → "over" (take the first childrenCount)
 */
export function accumulateAges(
  collected:     number[],
  incoming:      number[],
  childrenCount: number,
): AgeAccumulation {
  const merged = [...collected, ...incoming];
  if (merged.length === childrenCount) return { ages: merged, status: "complete" };
  if (merged.length <  childrenCount) return { ages: merged, status: "partial" };
  return { ages: merged.slice(0, childrenCount), status: "over" };
}

// ── Reclassification (Task 3) ─────────────────────────────────────────────────

export type ReclassResult = {
  effectiveAdults:       number;
  effectiveChildren:     number;
  effectiveChildrenAges: number[];
  promotedToAdult:       number;
};

/**
 * Children strictly older than `childAgeLimit` are counted as adults. Pure.
 * A null/undefined limit means "no reclassification" (everyone stays as-is).
 */
export function reclassifyGuests(
  adults:        number,
  children:      number,
  childrenAges:  number[],
  childAgeLimit: number | null | undefined,
): ReclassResult {
  if (childAgeLimit == null) {
    return {
      effectiveAdults:       adults,
      effectiveChildren:     children,
      effectiveChildrenAges: [...childrenAges],
      promotedToAdult:       0,
    };
  }
  const promotedToAdult       = childrenAges.filter((a) => a > childAgeLimit).length;
  const effectiveChildrenAges = childrenAges.filter((a) => a <= childAgeLimit);
  return {
    effectiveAdults:   adults + promotedToAdult,
    effectiveChildren: children - promotedToAdult,
    effectiveChildrenAges,
    promotedToAdult,
  };
}

/**
 * WhatsApp-safe occupancy summary (Task 4). Caller sends it only when
 * promotedToAdult > 0. Bold/italic + newlines only — no box-drawing, no headers.
 */
export function buildOccupancyNotice(
  effectiveAdults:   number,
  effectiveChildren: number,
  promotedToAdult:   number,
  childAgeLimit:     number,
): string {
  const who = promotedToAdult > 1
    ? `${promotedToAdult} of your children are`
    : `One of your children is`;
  const counted = promotedToAdult > 1 ? "adults" : "an adult";
  return (
    `*Occupancy Summary* 👥\n\n` +
    `Adults: *${effectiveAdults}*   Children: *${effectiveChildren}*\n\n` +
    `_${who} above ${childAgeLimit} years and will be counted as ${counted} per hotel policy._`
  );
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

/**
 * Confirm-step reply: when a button sender is injected, send the allocation
 * summary (WITHOUT the text footer) as an interactive 3-button message and
 * return "ALREADY_SENT". Otherwise return the legacy text summary with the
 * reply-instructions footer (full back-compat — tests with no dep are unchanged).
 */
async function confirmReply(
  deps: AdvancedRoomAllocationDeps,
  rooms: AllocationRoom[],
  childrenAges: number[] | undefined,
): Promise<string> {
  if (deps.sendConfirmButtons) {
    const bodyText = renderAllocationSummary(rooms, { childrenAges }); // no text footer — buttons replace it
    const sent = await deps.sendConfirmButtons({ hotelId: deps.hotelId, guestId: deps.guestId, bodyText });
    if (sent) return "ALREADY_SENT";
  }
  return renderAllocationSummary(rooms, { trailing: confirmPromptFooter(), childrenAges });
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

/**
 * Room-descriptions text (Piece 1D). One block per AVAILABLE room type:
 *   *{name}* — ₹{basePrice}/night
 *   _{description}_   ← omitted entirely when the type has no description
 * WhatsApp-safe (bold/italic/newlines only). Pure + exported. Returns null when
 * there are no available room types (caller skips the send).
 */
export function buildRoomDescriptionsMessage(rooms: AllocationRoomInput[]): string | null {
  const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const available = rooms.filter((r) => r.availableCount > 0);
  if (available.length === 0) return null;

  const blocks = available.map((r) => {
    const head = `*${r.name}* — ${inr(r.basePrice)}/night`;
    const desc = (r.description ?? "").trim();
    return desc ? `${head}\n_${desc}_` : head; // no empty italic line when blank
  });

  return (
    `🏨 *Our Room Types*\n\n` +
    `${blocks.join("\n\n")}\n\n` +
    `_Tap the options below to choose your preferred room type_ 👇`
  );
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

  // Flat, message-friendly aliases so {{bookingTotal}} / {{roomCount}} /
  // {{allocatedRooms}} resolve directly (the output schema declares these keys).
  // bookingTotalPrice/bookingRooms are kept above for back-compat.
  flowVars["bookingTotal"]   = String(total);
  flowVars["roomCount"]      = String(allocated.length);
  flowVars["allocatedRooms"] = JSON.stringify(allocated);
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
  // OPTIONAL — hotel-wide child age threshold (HotelConfig.childAgeLimit). A child
  // strictly older than this is reclassified as an adult before allocation.
  // Absent → no reclassification (back-compat; everyone stays as collected).
  childAgeLimit?: number;
  // OPTIONAL — AI fallback for ambiguous age replies ("the twins are 8"). Returns
  // ages or null on any failure. Absent → regex-only collection.
  extractChildrenAges?: (reply: string) => Promise<number[] | null>;
  // OPTIONAL — sends the occupancy-summary text before the carousel when children
  // are promoted to adults. Absent → notice is skipped silently.
  sendOccupancyNotice?: (args: { hotelId: string; guestId: string; text: string }) => Promise<void>;
  // OPTIONAL (Piece 1D) — sends a plain-text room-descriptions message before the
  // carousel when the node's sendRoomDescriptions toggle is on. Absent → skipped.
  sendRoomDescriptions?: (args: { hotelId: string; guestId: string; text: string }) => Promise<void>;
  // OPTIONAL (Piece 2A) — sends the "Mix it up 🎲" interactive list AFTER the
  // carousel. Reply id "MIX_IT_UP". Returns true if sent. Absent → text fallback.
  sendMixItUpList?: (args: { hotelId: string; guestId: string }) => Promise<boolean>;
  // OPTIONAL — sends the suggested-allocation summary as an interactive 3-button
  // message (Confirm / Modify / Cancel). Returns true if sent (→ "ALREADY_SENT").
  // Absent → caller returns the legacy text summary with the reply-instructions
  // footer (full back-compat).
  sendConfirmButtons?: (args: { hotelId: string; guestId: string; bodyText: string }) => Promise<boolean>;
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

/**
 * Build the node-level allocation config. `childAgeLimit` is now hotel-wide:
 * the injected HotelConfig value (when provided) wins over the legacy node-data
 * field, which is kept only as a fallback for older flows / direct-config tests.
 */
function resolveConfig(
  data: AdvancedRoomAllocationNodeData,
  childAgeLimit?: number | null,
): AllocationConfig {
  return {
    baseAdults:       data.baseAdults       ?? 2,
    baseChildren:     data.baseChildren     ?? 0,
    maxAdults:        data.maxAdults        ?? 3,
    maxChildren:      data.maxChildren      ?? 1,
    extraAdultCharge: data.extraAdultCharge ?? 0,
    allowExtraBed:    data.allowExtraBed    ?? false,
    extraBedCharge:   data.extraBedCharge   ?? 0,
    childAgeLimit:    childAgeLimit ?? data.childAgeLimit ?? null,
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
      description:      r.description     ?? null,
      baseAdults:       r.baseAdults       ?? null,
      baseChildren:     r.baseChildren     ?? null,
      extraAdultCharge: r.extraAdultCharge ?? null,
      allowExtraBed:    r.allowExtraBed    ?? null,
      extraBedCharge:   r.extraBedCharge   ?? null,
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

  if (adults + children === 0) {
    await resetSession(guestId, hotelId);
    return "I need at least one guest to allocate a room. Please start over from the main menu.";
  }

  // ── Children-age collection (Task 1) ──────────────────────────────────────
  // If there are children and ages aren't already fully known, gather them
  // statefully (possibly across several messages) before allocating. Ages may be
  // pre-supplied via the configured childrenAgesVar; if that already has enough,
  // we skip collection entirely (full back-compat).
  let presetAges: number[] = [];
  const agesVarName = data.childrenAgesVar || "";
  if (agesVarName && vars[agesVarName]) {
    presetAges = extractAgesRegex(vars[agesVarName]);
  }

  if (children > 0 && presetAges.length < children) {
    // Enter stateful collection. The first prompt asks for the ages.
    const collectState: AraState = {
      guests:          { adults, children },
      selectedRooms:   [],
      remainingGuests: { adults: 0, children: 0 },
      phase:           "collecting_ages",
      ageCollection:   { adults, children, childrenCount: children, collectedAges: [], rounds: 0 },
    };
    writeState(vars, collectState);
    flowData.waitingFor = "answer";
    await persist(deps);
    return children === 1
      ? "How old is your child? 👶"
      : `Please share the ages of your ${children} children — e.g. 5, 8 and 12 👶`;
  }

  // No children, or ages already supplied → reclassify and allocate immediately.
  // Pre-supplied ages are passed through verbatim (back-compat: a count mismatch
  // is preserved, and the summary's own equal-length check decides display).
  return reclassifyAndProceed(deps, { adults, children, childrenAges: presetAges, checkIn, checkOut, nights, config });
}

/**
 * Reclassify children over the hotel age limit into adults (Task 3), optionally
 * send the occupancy notice (Task 4), then run the allocator with the EFFECTIVE
 * counts. Shared by phase1 (no-ages path) and the collecting_ages completion.
 * The base-first allocator is never touched — only its inputs.
 */
async function reclassifyAndProceed(
  deps: AdvancedRoomAllocationDeps,
  args: { adults: number; children: number; childrenAges: number[]; checkIn: string; checkOut: string; nights: number; config: AllocationConfig },
): Promise<string | null> {
  const { hotelId, guestId, flowData } = deps;
  const vars = flowData.flowVars;
  const { adults, children, childrenAges, checkIn, checkOut, nights } = args;

  // childAgeLimit on the resolved config now comes from the injected HotelConfig
  // value (deps.childAgeLimit), falling back to node-data inside resolveConfig.
  const config = { ...args.config, childAgeLimit: deps.childAgeLimit ?? args.config.childAgeLimit };

  const { effectiveAdults, effectiveChildren, effectiveChildrenAges, promotedToAdult } =
    reclassifyGuests(adults, children, childrenAges, config.childAgeLimit);

  // Persist the four computed values as flowVars (Task 3).
  flowData.flowVars = {
    ...flowData.flowVars,
    effectiveAdults:       String(effectiveAdults),
    effectiveChildren:     String(effectiveChildren),
    effectiveChildrenAges: JSON.stringify(effectiveChildrenAges),
    promotedToAdult:       String(promotedToAdult),
  };

  // Occupancy notice (Task 4) — only when at least one child became an adult.
  if (promotedToAdult > 0 && deps.sendOccupancyNotice && config.childAgeLimit != null) {
    const text = buildOccupancyNotice(effectiveAdults, effectiveChildren, promotedToAdult, config.childAgeLimit);
    await deps.sendOccupancyNotice({ hotelId, guestId, text });
  }

  return proceedToAllocation(deps, {
    effectiveAdults,
    effectiveChildren,
    effectiveChildrenAges,
    checkIn,
    checkOut,
    nights,
    config,
  });
}

/**
 * Build inventory, generate plans, and branch into the single-summary / plan
 * list flow exactly as before — but using the EFFECTIVE (post-reclassification)
 * guest counts. The allocation algorithm itself is unchanged.
 */
async function proceedToAllocation(
  deps: AdvancedRoomAllocationDeps,
  args: { effectiveAdults: number; effectiveChildren: number; effectiveChildrenAges: number[]; checkIn: string; checkOut: string; nights: number; config: AllocationConfig },
): Promise<string | null> {
  const { hotelId, guestId, flowData, fetchRoomTypes, getCalendarData, resetSession } = deps;
  const vars = flowData.flowVars;
  const { effectiveAdults: adults, effectiveChildren: children, effectiveChildrenAges, checkIn, checkOut, nights, config } = args;

  const roomInputs = await buildInventoryRooms(hotelId, checkIn, checkOut, fetchRoomTypes, getCalendarData);

  // Inventory-exhaustion guard: if no combination can house the party at all,
  // fail gracefully BEFORE sending the carousel (no point asking for a preference).
  const feasible = allocateRooms({ adults, children, rooms: roomInputs, config, nights });
  if (!feasible || feasible.length === 0) {
    await resetSession(guestId, hotelId);
    return `Sorry, we don't have enough rooms for ${adults + children} guests on those dates. Please contact us directly or try different dates.`;
  }

  const childrenAges = effectiveChildrenAges;
  const guestsField = { adults, children, ...(childrenAges.length > 0 ? { childrenAges } : {}) };
  const node = (deps.node.data ?? {}) as AdvancedRoomAllocationNodeData;

  // ── Piece 2A: carousel-first preference collection. ──
  // 1D — optional room-descriptions text before the carousel.
  if (node.sendRoomDescriptions && deps.sendRoomDescriptions) {
    const descText = buildRoomDescriptionsMessage(roomInputs);
    if (descText) await deps.sendRoomDescriptions({ hotelId, guestId, text: descText });
  }

  // Enter collecting_room_preference and persist the inventory snapshot so the
  // preference handler can generate plans without re-querying.
  const prefState: AraState = {
    guests:          guestsField,
    selectedRooms:   [],
    remainingGuests: { adults: 0, children: 0 },
    phase:           "collecting_room_preference",
    prefCollection:  { adults, children, nights, rooms: roomInputs },
  };
  writeState(vars, prefState);
  flowData.waitingFor = "answer";
  await persist(deps);

  // Message: room-type carousel (cards = room types; tap sets the preference).
  if (deps.sendRoomCarousel) {
    await deps.sendRoomCarousel({ hotelId, guestId, roomInputs, adults });
  }

  // Message: "Mix it up 🎲" interactive list AFTER the carousel.
  if (deps.sendMixItUpList) {
    const sent = await deps.sendMixItUpList({ hotelId, guestId });
    if (sent) return "ALREADY_SENT";
  }
  // Text fallback (no list dep): tell the guest how to pick / mix.
  return "_Not sure? Reply *MIX* and we'll pick the best combination for you_ 🎲";
}

/**
 * Generate preference-aware plans and send the plan list (Piece 2B/2C). Shared by
 * the preference handler. Writes plan_selection state. Returns the reply string
 * ("ALREADY_SENT" when the list was dispatched, else a text fallback / error).
 */
async function generateAndSendPlans(
  deps: AdvancedRoomAllocationDeps,
  args: {
    guestsField:          AraState["guests"];
    preferredRoomTypeId:  string | null;
    pref:                 NonNullable<AraState["prefCollection"]>;
  },
): Promise<string | null> {
  const { hotelId, guestId, flowData, resetSession } = deps;
  const vars = flowData.flowVars;
  const { guestsField, preferredRoomTypeId, pref } = args;

  const node    = (deps.node.data ?? {}) as AdvancedRoomAllocationNodeData;
  const maxPlans = typeof node.maxPlans === "number" ? node.maxPlans : 4;
  const config   = { ...resolveConfig(node), childAgeLimit: deps.childAgeLimit ?? resolveConfig(node).childAgeLimit };

  const plans = generateSmartPlans({
    adults:   pref.adults,
    children: pref.children,
    rooms:    pref.rooms,
    config,
    nights:   pref.nights,
    preferredRoomTypeId,
    maxPlans,
  });

  if (plans.length === 0) {
    await resetSession(guestId, hotelId);
    return `Sorry, we don't have enough rooms for ${pref.adults + pref.children} guests on those dates. Please contact us directly or try different dates.`;
  }

  // Record the preference + plan count as flow vars (Piece 2E partial). Mutate
  // the live flowVars object in place — `vars` (and writeState below) reference
  // it, so reassigning flowData.flowVars would orphan those writes.
  vars["preferredRoomTypeId"] = preferredRoomTypeId ?? "";
  vars["planCount"]           = String(plans.length);

  // Single plan → straight to confirm (no list needed).
  if (plans.length === 1) {
    const only = plans[0]!;
    const newState: AraState = {
      guests:          guestsField,
      selectedRooms:   only.rooms,
      remainingGuests: { adults: 0, children: 0 },
      phase:           "confirm",
      preferredRoomTypeId,
      ...(only.planType ? { selectedPlanType: only.planType } : {}),
    };
    writeState(vars, newState);
    flowData.waitingFor = "answer";
    await persist(deps);
    return confirmReply(deps, only.rooms, guestsField.childrenAges);
  }

  // Multiple plans → plan_selection.
  const planState: AraState = {
    guests:          guestsField,
    selectedRooms:   [],
    remainingGuests: { adults: 0, children: 0 },
    phase:           "plan_selection",
    plans,
    eligibleRoomInputs: pref.rooms,
    preferredRoomTypeId,
  };
  writeState(vars, planState);
  flowData.waitingFor = "answer";
  await persist(deps);

  if (deps.sendPlanList) {
    const sent = await deps.sendPlanList({ hotelId, guestId, plans, eligibleRoomInputs: pref.rooms });
    if (sent) return "ALREADY_SENT";
  }
  return renderPlanTextFallback(plans);
}

/**
 * Stateful children-age collection handler (Task 1). One call per guest reply.
 * Parses regex-first, consults the AI fallback only for empty/ambiguous input,
 * accumulates across rounds, guards against non-age messages, and on completion
 * (or after MAX_AGE_ROUNDS, filling the rest with 0) hands off to
 * reclassifyAndProceed. Stays in "collecting_ages" until done.
 */
async function handleAgeCollection(deps: AdvancedRoomAllocationDeps, state: AraState): Promise<string | null> {
  const { input, flowData, hotelId, guestId, resetSession } = deps;
  const vars = flowData.flowVars;
  const ac = state.ageCollection;

  // Corrupt state guard — no working data → reset gracefully.
  if (!ac) {
    clearState(vars);
    await resetSession(guestId, hotelId);
    return "Something went wrong collecting the children's ages. Please start over from the main menu.";
  }

  const round = ac.rounds + 1;

  // Step 1 — regex first.
  let extracted = extractAgesRegex(input);

  // Step 2 — AI fallback ONLY when regex is empty or the reply is ambiguous.
  let aiTried = false;
  if (deps.extractChildrenAges && needsAiAgeParse(input)) {
    aiTried = true;
    const aiAges = await deps.extractChildrenAges(input);
    if (aiAges && aiAges.length > 0) extracted = aiAges;
  }

  // Step 4 — non-age message guard: nothing parsed AND no age words → re-prompt,
  // no advance. Counts as a round (so a stream of junk can't loop forever).
  if (extracted.length === 0) {
    const exhausted = round >= MAX_AGE_ROUNDS;
    if (!exhausted) {
      const next: AraState = { ...state, ageCollection: { ...ac, rounds: round } };
      writeState(vars, next);
      flowData.waitingFor = "answer";
      await persist(deps);
      return "I just need the ages of your children to continue — e.g. 5, 8 and 12 👶";
    }
    // Rounds exhausted with nothing parsed this turn → fall through to fill logic.
  }

  // Step 3 — accumulate.
  const acc = accumulateAges(ac.collectedAges, extracted, ac.childrenCount);

  if (acc.status === "complete" || acc.status === "over") {
    return finishAgeCollection(deps, ac, acc.ages);
  }

  // status === "partial"
  if (round >= MAX_AGE_ROUNDS) {
    // Max rounds reached — fill remaining slots with 0 (a 0-year-old is a child
    // under any reasonable age limit) and proceed.
    const filled = [...acc.ages];
    while (filled.length < ac.childrenCount) filled.push(0);
    return finishAgeCollection(deps, ac, filled);
  }

  // Ask for the remaining ages, staying in the collection phase.
  const remaining = ac.childrenCount - acc.ages.length;
  const next: AraState = { ...state, ageCollection: { ...ac, collectedAges: acc.ages, rounds: round } };
  writeState(vars, next);
  flowData.waitingFor = "answer";
  await persist(deps);
  void aiTried; // (kept for clarity; AI use is internal)
  return (
    `Got ${acc.ages.join(", ")} — what's the age of your other ${remaining} ` +
    `${remaining === 1 ? "child" : "children"}?`
  );
}

/**
 * Ages are finalized — recompute dates/config and run reclassification + allocation.
 */
async function finishAgeCollection(
  deps: AdvancedRoomAllocationDeps,
  ac:   NonNullable<AraState["ageCollection"]>,
  childrenAges: number[],
): Promise<string | null> {
  const { node, hotelId, guestId, flowData, resetSession } = deps;
  const vars = flowData.flowVars;
  const data = (node.data ?? {}) as AdvancedRoomAllocationNodeData;
  const config = resolveConfig(data, deps.childAgeLimit);

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

  return reclassifyAndProceed(deps, {
    adults:   ac.adults,
    children: ac.children,
    childrenAges,
    checkIn,
    checkOut,
    nights,
    config,
  });
}

// ── Phase 2 helpers ───────────────────────────────────────────────────────────

// Interactive button ids (sent on the confirm summary). The webhook collapses a
// button_reply to a text body equal to the button id, so these arrive here as
// plain input alongside the legacy "1"/"2"/"MENU" replies.
const CONFIRM_BTN_ID = "CONFIRM_BOOKING";
const MODIFY_BTN_ID  = "MODIFY_BOOKING";
const CANCEL_BTN_ID  = "CANCEL_BOOKING";

function isConfirmInput(raw: string): boolean {
  const s = raw.trim();
  if (s.toUpperCase() === CONFIRM_BTN_ID) return true;
  const l = s.toLowerCase();
  return l === "1" || l === "confirm";
}
function isModifyInput(raw: string): boolean {
  const s = raw.trim();
  if (s.toUpperCase() === MODIFY_BTN_ID) return true;
  const l = s.toLowerCase();
  return l === "2" || l === "modify";
}
function isMenuInput(raw: string): boolean {
  const s = raw.trim().toUpperCase();
  return s === "MENU" || s === CANCEL_BTN_ID;
}
function isDoneInput(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  return s === "done" || s === "confirm";
}

async function finalizeAndAdvance(deps: AdvancedRoomAllocationDeps, allocated: AllocationRoom[]): Promise<string | null> {
  const { flowData, currentNodeId, adjacency, nextNodeId, advance, guestId, hotelId, resetSession, safeMenu } = deps;
  // Output contract write is guarded by !bookingRooms inside writeOutputContract.
  const wrote = writeOutputContract(flowData.flowVars, allocated);
  // Piece 2E — selectedPlanType from the (pre-clear) state. preferredRoomTypeId +
  // planCount were already written when the plan list was generated. Only write on
  // the first finalize (same idempotency window as the output contract).
  if (wrote) {
    const st = readState(flowData.flowVars);
    if (st?.selectedPlanType) flowData.flowVars["selectedPlanType"] = st.selectedPlanType;
  }
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

  // ── Children-age collection sub-phase (Task 1) ─────────────────────────────
  // (MENU is already handled globally above.)
  if (state.phase === "collecting_ages") {
    return handleAgeCollection(deps, state);
  }

  // ── Room-preference collection sub-phase (Piece 2A) ────────────────────────
  // Guest taps a carousel card (room_TYPE:{id}) → that's the preferred type;
  // taps/types "Mix it up" (MIX_IT_UP / "mix") → no preference. Then we generate
  // preference-aware plans and send the plan list. (MENU handled globally above.)
  if (state.phase === "collecting_room_preference") {
    const pref = state.prefCollection;
    if (!pref) {                         // corrupt state → reset gracefully
      clearState(vars);
      await resetSession(guestId, hotelId);
      return safeMenu(hotelId);
    }
    const t = input.trim();

    // "Mix it up" — list reply id MIX_IT_UP, or a typed "mix" fallback.
    if (/^MIX_IT_UP$/i.test(t) || /^mix$/i.test(t)) {
      return generateAndSendPlans(deps, { guestsField: state.guests, preferredRoomTypeId: null, pref });
    }

    // Carousel card tap — "room_TYPE:{id}" (or "ROOM_TYPE:{id}" text fallback).
    const tappedId = t.match(/^room_TYPE:(.+)$/i)?.[1] ?? t.match(/^ROOM_TYPE:(.+)$/i)?.[1];
    if (tappedId) {
      const known = pref.rooms.some((r) => r.roomTypeId === tappedId && r.availableCount > 0);
      const preferredRoomTypeId = known ? tappedId : null; // unknown id → treat as no preference
      return generateAndSendPlans(deps, { guestsField: state.guests, preferredRoomTypeId, pref });
    }

    // Unrecognised reply → re-prompt (stay in the phase, no mutation).
    return "Please tap a room type from the cards above, or *Mix it up 🎲* to let us choose. Reply *MENU* to cancel.";
  }

  // ── Plan selection sub-phase ───────────────────────────────────────────────
  // (MENU is already handled globally above.) Carousel taps are handled in the
  // preference phase now; here we only accept a plan choice.
  if (state.phase === "plan_selection") {
    const plans = state.plans ?? [];
    if (plans.length === 0) {            // corrupt state → reset gracefully
      clearState(vars);
      await resetSession(guestId, hotelId);
      return safeMenu(hotelId);
    }

    const t = input.trim();

    // ── Plan selection: "plan_N" (0-based) or text "1".."N" ──
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
      guests:              state.guests,
      selectedRooms:       chosen.rooms,
      remainingGuests:     { adults: 0, children: 0 },
      phase:               "confirm",
      selectedPlanIndex:   idx,
      ...(state.preferredRoomTypeId !== undefined ? { preferredRoomTypeId: state.preferredRoomTypeId } : {}),
      ...(chosen.planType ? { selectedPlanType: chosen.planType } : {}),
    };
    writeState(vars, confirmState);
    await persist(deps);
    return confirmReply(deps, chosen.rooms, state.guests.childrenAges);
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
