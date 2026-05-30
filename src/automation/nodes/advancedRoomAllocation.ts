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
  phase:           "confirm" | "manual";
};

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

// ── Allocation engine (pure) ──────────────────────────────────────────────────

/**
 * Greedy minimum-room allocator.
 *
 * Strategy: sort by largest effective adult capacity (ties → cheaper first) so
 * we fill the smallest number of rooms; respect per-roomType availableCount as
 * a hard constraint by decrementing as we go.
 *
 * Returns null if no allocation is possible given inventory.
 */
export function allocateRooms(args: {
  adults:   number;
  children: number;
  rooms:    AllocationRoomInput[];
  config:   AllocationConfig;
  nights:   number;
}): AllocationRoom[] | null {
  const { adults, children, rooms, config, nights } = args;

  // Edge: no guests requested — nothing to allocate.
  if (adults <= 0 && children <= 0) return [];
  if (nights <= 0) return null;

  const extraBedBonus = config.allowExtraBed ? 1 : 0;

  // Effective per-room caps: config policy further constrained by the room's
  // own DB capacity. Null DB caps mean "no DB-side limit" → fall back to policy.
  const effMaxAdults = (r: AllocationRoomInput): number =>
    Math.min(config.maxAdults + extraBedBonus, r.maxAdults ?? Infinity);
  const effMaxChildren = (r: AllocationRoomInput): number =>
    Math.min(config.maxChildren, r.maxChildren ?? Infinity);

  const sorted = [...rooms].sort((a, b) => {
    const ca = effMaxAdults(a);
    const cb = effMaxAdults(b);
    if (cb !== ca) return cb - ca;
    return a.basePrice - b.basePrice; // tie-break: cheaper first
  });

  // Mutable copy of availability so we never exceed it.
  const remainingAvail = new Map<string, number>();
  for (const r of rooms) remainingAvail.set(r.roomTypeId, r.availableCount);

  const allocated: AllocationRoom[] = [];
  let remA = adults;
  let remC = children;

  // Guard against pathological inputs that would never terminate.
  const MAX_ROOMS = 50;

  while (remA > 0 || remC > 0) {
    if (allocated.length >= MAX_ROOMS) return null;

    let chosen: AllocationRoomInput | null = null;
    let chosenAdults = 0;
    let chosenChildren = 0;

    for (const r of sorted) {
      if ((remainingAvail.get(r.roomTypeId) ?? 0) <= 0) continue;
      const a = Math.min(remA, effMaxAdults(r));
      const c = Math.min(remC, effMaxChildren(r));
      if (a + c === 0) continue; // room can hold nobody from the remaining pool
      chosen = r;
      chosenAdults = a;
      chosenChildren = c;
      break;
    }

    if (!chosen) return null; // out of available rooms

    const rc           = resolveRoomConfig(chosen, config);
    const extraAdults  = Math.max(0, chosenAdults - rc.baseAdults);
    const extraBed     = chosenAdults > rc.baseAdults;
    const extraAdultCost = extraAdults * rc.extraAdultCharge;
    // Extra-bed charge only applies when the room type permits an extra bed.
    const extraBedCost = rc.allowExtraBed && extraBed ? rc.extraBedCharge : 0;
    const pricePerNight = chosen.basePrice + extraAdultCost + extraBedCost;

    allocated.push({
      roomTypeId:    chosen.roomTypeId,
      roomTypeName:  chosen.name,
      adults:        chosenAdults,
      children:      chosenChildren,
      extraBed,
      basePrice:     chosen.basePrice,
      extraAdultCost,
      extraBedCost,
      childAgeLimit: rc.childAgeLimit,
      pricePerNight,
      nights,
      totalPrice:    pricePerNight * nights,
    });

    remA -= chosenAdults;
    remC -= chosenChildren;
    remainingAvail.set(chosen.roomTypeId, (remainingAvail.get(chosen.roomTypeId) ?? 0) - 1);
  }

  return allocated;
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
};

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
  const allocated  = allocateRooms({ adults, children, rooms: roomInputs, config, nights });

  if (!allocated || allocated.length === 0) {
    await resetSession(guestId, hotelId);
    return `Sorry, we don't have enough rooms for ${adults + children} guests on those dates. Please contact us directly or try different dates.`;
    // ↑ Spec-mandated graceful failure (step 3 inventory-exhaustion path).
  }

  const newState: AraState = {
    guests:          { adults, children, ...(childrenAges.length > 0 ? { childrenAges } : {}) },
    selectedRooms:   allocated,
    remainingGuests: { adults: 0, children: 0 },
    phase:           "confirm",
  };
  writeState(vars, newState);

  flowData.waitingFor = "answer";
  await persist(deps);

  return renderAllocationSummary(allocated, { trailing: confirmPromptFooter(), childrenAges });
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

  // ── Confirm sub-phase ──────────────────────────────────────────────────────
  if (state.phase === "confirm") {
    if (isConfirmInput(input)) {
      return finalizeAndAdvance(deps, state.selectedRooms);
    }
    if (isModifyInput(input)) {
      // Switch to manual mode. Start from a CLEAN slate: clear selected rooms
      // and reset remaining guests to the full requested count.
      const next: AraState = {
        guests:          state.guests,
        selectedRooms:   [],
        remainingGuests: { adults: state.guests.adults, children: state.guests.children },
        phase:           "manual",
      };
      writeState(vars, next);
      await persist(deps);

      // Re-fetch room inputs so the prompt has live availability info.
      const checkIn  = vars["bookingCheckIn"]!;
      const checkOut = vars["bookingCheckOut"]!;
      const rooms = await buildInventoryRooms(hotelId, checkIn, checkOut, deps.fetchRoomTypes, deps.getCalendarData);
      return buildManualRoomList(rooms, next.remainingGuests);
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

  if (isDoneInput(input)) {
    if (state.selectedRooms.length === 0) {
      return `You haven't picked any rooms yet. ${buildManualRoomList(rooms, state.remainingGuests)}`;
    }
    return finalizeAndAdvance(deps, state.selectedRooms);
  }

  // Room pick by number.
  const pick = parseInt(input.trim(), 10);
  if (!Number.isFinite(pick) || pick < 1 || pick > rooms.length) {
    return `Please reply with a room number (1–${rooms.length}), *DONE* to finish, or *MENU* to cancel.`;
  }
  const room = rooms[pick - 1]!;

  // Subtract this room's availability against what's already selected of the same type.
  const alreadyPickedOfType = state.selectedRooms.filter((r) => r.roomTypeId === room.roomTypeId).length;
  if (room.availableCount - alreadyPickedOfType <= 0) {
    return `Sorry, no more *${room.name}* rooms available for those dates. Please pick another.`;
  }

  // Fill this room with as many remaining guests as it can hold (config policy + DB caps).
  const data = (deps.node.data ?? {}) as AdvancedRoomAllocationNodeData;
  const config = resolveConfig(data);
  const nights = countNights(checkIn, checkOut);
  const effMaxAdults   = Math.min(config.maxAdults + (config.allowExtraBed ? 1 : 0), room.maxAdults ?? Infinity);
  const effMaxChildren = Math.min(config.maxChildren, room.maxChildren ?? Infinity);
  const takeAdults     = Math.min(state.remainingGuests.adults,   effMaxAdults);
  const takeChildren   = Math.min(state.remainingGuests.children, effMaxChildren);

  if (takeAdults + takeChildren === 0) {
    return `All your guests are already placed. Reply *DONE* to confirm or *MENU* to cancel.\n\n${renderAllocationSummary(state.selectedRooms, { childrenAges: state.guests.childrenAges })}`;
  }

  const rc           = resolveRoomConfig(room, config);
  const extraAdults  = Math.max(0, takeAdults - rc.baseAdults);
  const extraBed     = takeAdults > rc.baseAdults;
  const extraAdultCost = extraAdults * rc.extraAdultCharge;
  const extraBedCost = rc.allowExtraBed && extraBed ? rc.extraBedCharge : 0;
  const pricePerNight = room.basePrice + extraAdultCost + extraBedCost;

  const newRoom: AllocationRoom = {
    roomTypeId:    room.roomTypeId,
    roomTypeName:  room.name,
    adults:        takeAdults,
    children:      takeChildren,
    extraBed,
    basePrice:     room.basePrice,
    extraAdultCost,
    extraBedCost,
    childAgeLimit: rc.childAgeLimit,
    pricePerNight,
    nights,
    totalPrice:    pricePerNight * nights,
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

  const summary = renderAllocationSummary(updated.selectedRooms, { childrenAges: updated.guests.childrenAges });
  if (updated.remainingGuests.adults + updated.remainingGuests.children === 0) {
    return `${summary}\n\nAll guests placed. Reply *DONE* to confirm or *MENU* to cancel.`;
  }
  return `${summary}\n\n${buildManualRoomList(rooms, updated.remainingGuests)}`;
}
