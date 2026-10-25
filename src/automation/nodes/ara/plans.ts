/**
 * ara/plans.ts — the live multi-plan generator (pure, testable).
 *
 * Orchestration layer ONLY. Every candidate is produced by the protected
 * `allocateRooms` engine; this module just chooses inputs (which room types,
 * which strategy) and labels/dedups/ranks the results.
 */

import { allocateRooms } from "./allocator";
import { inr } from "./money";
import type {
  AllocationConfig,
  AllocationPlan,
  AllocationRoom,
  AllocationRoomInput,
  PlanType,
} from "./types";

/** Build an AllocationPlan from an allocated room list. */
export function toPlan(
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

/** Primary room-type name for a plan ("Deluxe" or "Deluxe mix" for mixed types). */
export function planTypeName(plan: AllocationPlan): string {
  const primary = plan.rooms.find((r) => r.roomTypeId === plan.primaryRoomTypeId) ?? plan.rooms[0];
  const name    = primary?.roomTypeName ?? "Room";
  const allSame = plan.rooms.length > 0 && plan.rooms.every((r) => r.roomTypeId === plan.primaryRoomTypeId);
  return allSame ? name : `${name} mix`;
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
export function planSignature(p: AllocationPlan): string {
  const counts = new Map<string, number>();
  for (const r of p.rooms) counts.set(r.roomTypeId, (counts.get(r.roomTypeId) ?? 0) + 1);
  const comp = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, c]) => `${id}x${c}`).join(",");
  return `${comp}|${p.totalPrice}`;
}

/** True if `p` differs meaningfully from every plan in `existing` (Piece 2 dynamic rule). */
export function isDistinctPlan(p: AllocationPlan, existing: AllocationPlan[]): boolean {
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
export function cheapestType(rooms: AllocationRoomInput[]): AllocationRoomInput | undefined {
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
