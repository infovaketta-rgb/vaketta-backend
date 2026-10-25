/**
 * ara/types.ts — every shared type for the advanced_room_allocation node.
 *
 * Types only: this module must stay free of runtime imports so the pure core can
 * be unit-tested without flowRuntime's module-load chain (Redis at import,
 * Prisma, queues, AI). Same isolation principle as interpolate.ts.
 *
 * Canonical home of `RoomAction` — modifyLists.ts re-exports it from here.
 */

import type {
  AdvancedRoomAllocationNodeData,
  SerializedFlowNode,
} from "../../flowTypes";
import type { SessionData } from "../../../services/session.service";

export type { AdvancedRoomAllocationNodeData };

// ── Allocation model ──────────────────────────────────────────────────────────

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
  phase:           "collecting_ages" | "confirming_ages" | "collecting_room_preference" | "confirm" | "manual" | "room_menu" | "move_from_count" | "move_to_room" | "change_type_select" | "plan_selection";
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
    // Sticky across rounds: at least one reply was parsed by the AI rather than
    // read off a bare digit list, so the final set is not a literal transcription
    // and gets read back to the guest. Optional — absent on pre-existing sessions.
    aiUsed?:       boolean;
  };
  // Age read-back (present during "confirming_ages"). `ages` is what we are about
  // to allocate with; `corrections` counts rejections already spent, capped at
  // MAX_AGE_CORRECTIONS so reject → re-prompt cannot loop.
  ageConfirm?: {
    ages:        number[];
    corrections: number;
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

// ── Manual-modification results ───────────────────────────────────────────────

/** Resolves the effective per-room config for an already-allocated room. */
export type RoomConfigResolver = (room: AllocationRoom) => AllocationConfig;

export type ApplyResult =
  | { ok: true;  rooms: AllocationRoom[]; returnedGuests?: { adults: number; children: number } }
  | { ok: false; outOfRange: boolean; reason: string };

// ── Structured-modify menu ────────────────────────────────────────────────────

export type RoomAction = "add_bed" | "remove_bed" | "move_guest" | "change_type" | "remove_room";

/** The two phases the AI free-text fallback can run in. */
export type ModifyPhase = "confirm" | "manual";

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

export type FlowData = {
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
  safeMenu:       (hotelId: string, guestId: string) => Promise<string | null>;
  fetchRoomTypes: FetchRoomTypesFn;
  getCalendarData: GetCalendarDataFn;
  // OPTIONAL — step-level retry. Rewinds to the node that collected `variable`,
  // clears just that value and re-prompts, preserving every other answer.
  // Returns null when the rewind isn't possible (unknown variable or the retry
  // budget is spent), in which case the caller falls back to its existing
  // reset-and-restart. Absent → callers reset exactly as they did before, so
  // every existing test and flow keeps its old behaviour.
  retryStep?: (variable: string, message: string) => Promise<string | null>;
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
  // OPTIONAL — AI parser for every age reply that is not a bare list of digits
  // ("all 5", "the twins are 8", "all 3 are 5"). `childrenCount` is how many ages
  // are expected, passed as context so a quantifier reply can be expanded to one
  // age per child. Returns ages or null on any failure. Absent → regex-only
  // collection (the pre-existing behaviour).
  extractChildrenAges?: (reply: string, childrenCount: number) => Promise<number[] | null>;
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
  // OPTIONAL — sends the room-action menu (room_menu phase) as an interactive list.
  // Returns true if sent (→ "ALREADY_SENT"). Absent → plain-text renderRoomMenu.
  sendRoomMenuList?: (args: { hotelId: string; guestId: string; room: AllocationRoom; options: RoomAction[]; roomIndex: number }) => Promise<boolean>;
  // OPTIONAL — sends the "move to which room?" picker (move_to_room phase) as an
  // interactive list. Returns { sent, destIndices } so the handler knows the slot→
  // roomIndex mapping. Absent → plain-text renderMoveToRoom.
  sendMoveToRoomList?: (args: { hotelId: string; guestId: string; state: AraState; fromIndex: number; pending: { adults: number; children: number }; resolveCfg: RoomConfigResolver }) => Promise<{ sent: boolean; destIndices: number[] }>;
  // OPTIONAL — sends the manual-mode booking overview (manual phase) as an
  // interactive list. Returns true if sent (→ "ALREADY_SENT"). Absent → text.
  sendManualModeList?: (args: { hotelId: string; guestId: string; state: AraState; addable: AllocationRoomInput[] }) => Promise<boolean>;
  // OPTIONAL — sends the "change room type" picker (change_type_select phase) as
  // an interactive list. Returns true if sent (→ "ALREADY_SENT"). Absent → text.
  sendChangeRoomTypeList?: (args: { hotelId: string; guestId: string; room: AllocationRoom; roomIndex: number; candidates: AllocationRoomInput[] }) => Promise<boolean>;
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
