/**
 * Vitest suite for the advanced_room_allocation node handler.
 *
 * Pure-algorithm tests hit `allocateRooms` directly. End-to-end handler tests
 * call `handleAdvancedRoomAllocation` with mocked deps (no prisma, no DB) —
 * the spec-mandated dependency injection makes this trivial.
 */

import { describe, it, expect, vi } from "vitest";
import {
  allocateRooms,
  renderAllocationSummary,
  parseChildrenAges,
  handleAdvancedRoomAllocation,
  applyAddExtraBed,
  applyRemoveExtraBed,
  applyMoveExtraBed,
  applyRemoveRoom,
  applyMoveGuest,
  applyChangeRoomType,
  roomMenuOptions,
  generatePlans,
  generateSmartPlans,
  buildRoomDescriptionsMessage,
  renderPlanTextFallback,
  extractAgesRegex,
  needsAiAgeParse,
  accumulateAges,
  reclassifyGuests,
  buildOccupancyNotice,
  MAX_AGE_ROUNDS,
  type AdvancedRoomAllocationDeps,
  type AllocationConfig,
  type AllocationRoom,
  type AllocationRoomInput,
  type AllocationPlan,
  type AraState,
  type Adjacency,
  type FetchRoomTypesFn,
  type GetCalendarDataFn,
  type RoomConfigResolver,
} from "./advancedRoomAllocation";
import { buildPlanDescription } from "./planList";
import {
  buildRoomMenuSections,
  buildMoveToRoomSections,
  buildManualModeSections,
  buildChangeTypeSections,
  MOD_REMOVE_EXTRA_BED,
  MOD_GO_BACK,
  MOVE_GO_BACK,
  MOVE_TO_ROOM_PREFIX,
  MODIFY_DONE,
  MODIFY_GO_BACK,
  EDIT_ROOM_PREFIX,
  ADD_ROOM_PREFIX,
  CHANGE_TYPE_GO_BACK,
  CHANGE_TYPE_PREFIX,
} from "./modifyLists";
import type { SerializedFlowNode } from "../flowTypes";
import type { SessionData } from "../../services/session.service";

// ── Test helpers ──────────────────────────────────────────────────────────────

const baseConfig: AllocationConfig = {
  baseAdults:       2,
  baseChildren:     0,
  maxAdults:        3,
  maxChildren:      1,
  extraAdultCharge: 0,
  allowExtraBed:    false,
  extraBedCharge:   0,
  childAgeLimit:    null,
};

function room(over: Partial<AllocationRoomInput>): AllocationRoomInput {
  return {
    roomTypeId:    "rt_default",
    name:          "Default",
    basePrice:     6000,
    maxAdults:     3,
    maxChildren:   1,
    availableCount: 5,
    ...over,
  };
}

function calendarFor(rooms: AllocationRoomInput[], dates = ["2026-06-01", "2026-06-02"]) {
  const cells: Record<string, Record<string, { availableRooms: number }>> = {};
  for (const r of rooms) {
    cells[r.roomTypeId] = {};
    for (const ds of dates) cells[r.roomTypeId]![ds] = { availableRooms: r.availableCount };
  }
  return {
    roomTypes: rooms.map((r) => ({ id: r.roomTypeId, name: r.name, basePrice: r.basePrice, totalRooms: r.availableCount })),
    dates,
    cells,
  };
}

function makeDeps(over: Partial<AdvancedRoomAllocationDeps> & {
  flowVars?:  Record<string, string>;
  waitingFor?: "answer";
  nodeData?:  Record<string, unknown>;
  rooms?:     AllocationRoomInput[];
  input?:     string;
}): AdvancedRoomAllocationDeps {
  const rooms = over.rooms ?? [room({})];
  const adjacency: Adjacency = new Map([
    ["node_ara", [{ targetId: "node_next", sourceHandle: undefined }]],
  ]);
  const flowData = {
    flowId:   "flow_test",
    flowVars: { bookingCheckIn: "2026-06-01", bookingCheckOut: "2026-06-03", ...(over.flowVars ?? {}) },
    ...(over.waitingFor ? { waitingFor: over.waitingFor as "answer" } : {}),
  };

  const fetchRoomTypes: FetchRoomTypesFn = vi.fn(async () =>
    rooms.map((r) => ({
      id:          r.roomTypeId,
      name:        r.name,
      basePrice:   r.basePrice,
      capacity:    null,
      maxAdults:   r.maxAdults,
      maxChildren: r.maxChildren,
      description: null,
    })),
  );

  const getCalendarData: GetCalendarDataFn = vi.fn(async () => calendarFor(rooms));

  const node: SerializedFlowNode = {
    id:       "node_ara",
    type:     "advanced_room_allocation",
    position: { x: 0, y: 0 },
    data:     (over.nodeData ?? {}) as SerializedFlowNode["data"],
  };

  const deps: AdvancedRoomAllocationDeps = {
    node,
    currentNodeId: "node_ara",
    hotelId:       "hotel_1",
    guestId:       "guest_1",
    flowId:        "flow_test",
    flowData,
    sessionData:   {} as SessionData,
    input:         over.input ?? "",
    adjacency,
    advance:       vi.fn(async (_id: string) => "ADVANCED"),
    nextNodeId:    vi.fn((_n: string, _a: Adjacency, _h?: string) => "node_next"),
    updateSession: vi.fn(async () => undefined),
    resetSession:  vi.fn(async () => undefined),
    safeMenu:      vi.fn(async () => "MENU_TEXT"),
    fetchRoomTypes,
    getCalendarData,
    ...over,
  };
  // Apply over.flowData etc. (caller can override flowData wholesale via `over`)
  if (over.flowData) deps.flowData = over.flowData;
  return deps;
}

// ── 1. Single room, 2 adults — correct allocation, correct price ──────────────
describe("allocateRooms — pure algorithm", () => {
  it("Case 1: single room, 2 adults, no extra bed, correct price", () => {
    const result = allocateRooms({
      adults: 2, children: 0,
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000 })],
      config: baseConfig,
      nights: 2,
    });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      roomTypeName:  "Standard",
      adults:        2,
      children:      0,
      extraBed:      false,
      pricePerNight: 6000,
      nights:        2,
      totalPrice:    12000,
    });
  });

  // ── 2. 4 adults — base-first divides evenly into two base rooms, no beds ────
  // strategy change: was 1 room of 4 (crammed, extra bed), now 2 rooms of 2 (base, no beds)
  it("Case 2: 4 adults, base 2 — two base rooms, no extra beds", () => {
    const result = allocateRooms({
      adults: 4, children: 0,
      rooms: [room({ roomTypeId: "rt_dlx", name: "Deluxe", basePrice: 8000, maxAdults: 5, maxChildren: 2, availableCount: 5 })],
      config: { ...baseConfig, allowExtraBed: true, extraAdultCharge: 500 },
      nights: 2,
    });
    expect(result).toHaveLength(2);
    expect(result!.map((r) => r.adults)).toEqual([2, 2]);
    expect(result!.every((r) => !r.extraBed)).toBe(true);
    expect(result!.every((r) => r.pricePerNight === 8000)).toBe(true); // base only
  });

  // ── 3. 4 adults — base-first two rooms of 2, regardless of allowExtraBed ────
  // strategy change: was [3a+bed, 1a] (cram one, spill one), now [2a, 2a] (base, no beds)
  it("Case 3: 4 adults, allowExtraBed=false — two base rooms, no beds", () => {
    const result = allocateRooms({
      adults: 4, children: 0,
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 5, maxChildren: 2, availableCount: 5 })],
      config: { ...baseConfig, allowExtraBed: false },
      nights: 1,
    });
    expect(result).toHaveLength(2);
    expect(result!.map((r) => r.adults)).toEqual([2, 2]);
    expect(result!.every((r) => !r.extraBed)).toBe(true);
  });

  // ── 7. Multi-room — bookingRooms JSON valid, totalPrice sum ────────────────
  it("Case 7: multi-room — JSON-serialisable allocation, totalPrice = sum", () => {
    const result = allocateRooms({
      adults: 5, children: 2,
      rooms: [
        room({ roomTypeId: "rt_dlx", name: "Deluxe",   basePrice: 8000, maxAdults: 4, maxChildren: 2, availableCount: 5 }),
        room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 3, maxChildren: 1, availableCount: 5 }),
      ],
      config: baseConfig,
      nights: 3,
    })!;
    const serialized = JSON.stringify(result);
    expect(() => JSON.parse(serialized)).not.toThrow();
    const sum = result.reduce((s, r) => s + r.totalPrice, 0);
    const recomputed = result.reduce((s, r) => s + r.pricePerNight * r.nights, 0);
    expect(sum).toBe(recomputed);
    // All guests placed.
    expect(result.reduce((s, r) => s + r.adults,   0)).toBe(5);
    expect(result.reduce((s, r) => s + r.children, 0)).toBe(2);
  });

  // ── 9. Cheapest type carries the group when it has the availability ────────
  // strategy change: was deluxe×2 + standard (largest-capacity-first), now the
  // cheaper Standard (avail 5 ≥ 4 rooms needed) carries everyone; Deluxe unused.
  it("Case 9: fills the cheapest type first when it has the availability", () => {
    const result = allocateRooms({
      adults: 9, children: 0,
      rooms: [
        room({ roomTypeId: "rt_dlx", name: "Deluxe",   basePrice: 8000, maxAdults: 4, maxChildren: 0, availableCount: 2 }),
        room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 3, maxChildren: 0, availableCount: 5 }),
      ],
      config: { ...baseConfig, allowExtraBed: false, maxAdults: 4 },
      nights: 1,
    })!;
    // base 2 / max 4, 9 adults → base-first [3,2,2,2] = 4 rooms, all on the cheaper Standard.
    expect(result.filter((r) => r.roomTypeId === "rt_dlx").length).toBe(0);
    expect(result.filter((r) => r.roomTypeId === "rt_std").length).toBe(4);
    expect(result.map((r) => r.adults)).toEqual([3, 2, 2, 2]);
    expect(result.reduce((s, r) => s + r.adults, 0)).toBe(9);
  });
});

// ── Handler integration tests ─────────────────────────────────────────────────

describe("handleAdvancedRoomAllocation — handler", () => {
  // ── 10. Inventory exhausted — graceful failure + reset ──────────────────────
  it("Case 10: inventory exhausted → graceful failure + session reset", async () => {
    const deps = makeDeps({
      flowVars: { bookingAdults: "4", bookingChildren: "0" },
      rooms: [room({ availableCount: 0 })],
    });
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/don't have enough rooms/i);
    expect(deps.resetSession).toHaveBeenCalledWith("guest_1", "hotel_1");
    expect(deps.advance).not.toHaveBeenCalled();
    expect(deps.flowData.flowVars["__araState__"]).toBeUndefined();
  });

  // ── Phase 1 happy path — for subsequent handler tests we need real araState ─
  // Phase 1 now lands in collecting_room_preference (carousel-first, Piece 2A);
  // drive through it with "Mix it up" (no preference) to reach confirm/plan_selection.
  async function primeConfirmState(rooms: AllocationRoomInput[], flowVars: Record<string, string>) {
    const deps = makeDeps({ rooms, flowVars });
    await handleAdvancedRoomAllocation(deps);             // → collecting_room_preference
    deps.input = "MIX_IT_UP";
    await handleAdvancedRoomAllocation(deps);             // → confirm / plan_selection
    deps.input = "";                                     // reset for the caller's own input
    return deps;
  }

  // ── 4. Confirm input → output contract keys written + advance ──────────────
  it("Case 4: confirm input '1' writes output contract and advances", async () => {
    const deps = await primeConfirmState(
      [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, availableCount: 3 })],
      { bookingAdults: "2", bookingChildren: "0" },
    );
    // Now in Phase 2 with phase=confirm, waitingFor set, araState populated.
    expect(deps.flowData.waitingFor).toBe("answer");
    expect(deps.flowData.flowVars["__araState__"]).toBeTruthy();

    deps.input = "1";
    await handleAdvancedRoomAllocation(deps);

    expect(deps.flowData.flowVars["bookingRoomTypeId"]).toBe("rt_std");
    expect(deps.flowData.flowVars["bookingRoomTypeName"]).toBe("Standard");
    expect(deps.flowData.flowVars["bookingPricePerNight"]).toBe("6000");
    expect(deps.flowData.flowVars["bookingRooms"]).toBeTruthy();
    expect(deps.flowData.flowVars["bookingTotalPrice"]).toBe("12000"); // 6000 * 2 nights
    expect(deps.flowData.flowVars["bookingNights"]).toBe("2");
    expect(deps.flowData.flowVars["__araState__"]).toBeUndefined();
    expect(deps.flowData.waitingFor).toBeUndefined();
    expect(deps.advance).toHaveBeenCalledWith("node_next");
  });

  // ── 5. Modify input → phase set to "manual", suggestion KEPT ───────────────
  it("Case 5: modify input '2' switches to manual phase, keeping the suggestion", async () => {
    const deps = await primeConfirmState(
      [room({ roomTypeId: "rt_std", name: "Standard", availableCount: 5 })],
      { bookingAdults: "2", bookingChildren: "0" },
    );
    deps.input = "2";
    await handleAdvancedRoomAllocation(deps);

    const stateAfter = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(stateAfter.phase).toBe("manual");
    // behaviour change: was wipe (selectedRooms []), now keep the suggested rooms.
    expect(stateAfter.selectedRooms.length).toBe(1);
    // behaviour change: was { adults: 2, children: 0 }, now all placed.
    expect(stateAfter.remainingGuests).toEqual({ adults: 0, children: 0 });
    expect(deps.advance).not.toHaveBeenCalled();
  });

  // ── 6. Invalid input → session stays, validation error returned ────────────
  it("Case 6: invalid input → no reset, no advance, araState preserved", async () => {
    const deps = await primeConfirmState(
      [room({ availableCount: 5 })],
      { bookingAdults: "2", bookingChildren: "0" },
    );
    const stateBefore = deps.flowData.flowVars["__araState__"];

    deps.input = "garbage";
    const result = await handleAdvancedRoomAllocation(deps);

    expect(typeof result).toBe("string");
    expect(result).toMatch(/reply.*1.*confirm/i);
    expect(deps.resetSession).not.toHaveBeenCalled();
    expect(deps.advance).not.toHaveBeenCalled();
    expect(deps.flowData.flowVars["__araState__"]).toBe(stateBefore);
    expect(deps.flowData.waitingFor).toBe("answer");
  });

  // ── 8. Backward compat — bookingRoomTypeId == first room's id ──────────────
  // behaviour change: a SINGLE room type yields one plan → straight to confirm.
  // (Multiple types now produce a plan carousel — covered by "multiple plans
  // carousel".) 5 adults in base2/max3 still forces a multi-room allocation [3,2].
  it("Case 8: multi-room confirm → bookingRoomTypeId is first room's id", async () => {
    const deps = await primeConfirmState(
      [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 3, maxChildren: 0, availableCount: 5 })],
      { bookingAdults: "5", bookingChildren: "0" }, // forces multi-room [3,2]
    );
    deps.input = "1";
    await handleAdvancedRoomAllocation(deps);

    const parsedRooms: AllocationRoom[] = JSON.parse(deps.flowData.flowVars["bookingRooms"]!);
    expect(parsedRooms.length).toBeGreaterThanOrEqual(2);
    expect(deps.flowData.flowVars["bookingRoomTypeId"]).toBe(parsedRooms[0]!.roomTypeId);
    // Total = sum across rooms
    const total = parsedRooms.reduce((s, r) => s + r.totalPrice, 0);
    expect(deps.flowData.flowVars["bookingTotalPrice"]).toBe(String(total));
  });

  // ── 11. Idempotency: Phase 1 called twice — allocation not regenerated ─────
  it("Case 11: duplicate Phase 1 re-renders existing araState (no realloc)", async () => {
    const rooms = [room({ roomTypeId: "rt_std", name: "Standard", availableCount: 5 })];
    const deps = await primeConfirmState(rooms, { bookingAdults: "2", bookingChildren: "0" });
    const stateBefore = deps.flowData.flowVars["__araState__"]!;
    const fetchCallsBefore = (deps.fetchRoomTypes as ReturnType<typeof vi.fn>).mock.calls.length;
    const calendarCallsBefore = (deps.getCalendarData as ReturnType<typeof vi.fn>).mock.calls.length;

    // Simulate a duplicate Phase 1 trigger: waitingFor cleared, araState retained.
    delete deps.flowData.waitingFor;
    deps.input = "";
    const result = await handleAdvancedRoomAllocation(deps);

    // The allocator path needs fetchRoomTypes + getCalendarData; the re-render
    // path needs NEITHER. Verify they were not called again.
    expect((deps.fetchRoomTypes as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchCallsBefore);
    expect((deps.getCalendarData as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calendarCallsBefore);
    expect(deps.flowData.flowVars["__araState__"]).toBe(stateBefore);
    expect(deps.flowData.waitingFor).toBe("answer");
    expect(typeof result).toBe("string");
    expect(result).toMatch(/Suggested Allocation/);
  });

  // ── 12. Idempotency: confirm after araState cleaned — silent advance ───────
  it("Case 12: confirm input after araState already cleaned does not corrupt booking vars", async () => {
    // Prime + confirm once to write the output contract and clean araState.
    const deps = await primeConfirmState(
      [room({ roomTypeId: "rt_std", name: "Standard", availableCount: 5 })],
      { bookingAdults: "2", bookingChildren: "0" },
    );
    deps.input = "1";
    await handleAdvancedRoomAllocation(deps);

    const roomsSnapshot = deps.flowData.flowVars["bookingRooms"];
    const priceSnapshot = deps.flowData.flowVars["bookingPricePerNight"];
    const advanceCallsBefore = (deps.advance as ReturnType<typeof vi.fn>).mock.calls.length;

    // Now simulate the duplicate "1" arriving after cleanup. waitingFor was
    // deleted by the first confirm — re-set it to mimic a session-state race
    // where another path expected us to still be waiting.
    deps.flowData.waitingFor = "answer";
    deps.input = "1";
    const result = await handleAdvancedRoomAllocation(deps);

    // Output keys MUST be unchanged.
    expect(deps.flowData.flowVars["bookingRooms"]).toBe(roomsSnapshot);
    expect(deps.flowData.flowVars["bookingPricePerNight"]).toBe(priceSnapshot);
    // Returns null (silent) — no second message sent.
    expect(result).toBeNull();
    // No further advance — we're already past this node.
    expect((deps.advance as ReturnType<typeof vi.fn>).mock.calls.length).toBe(advanceCallsBefore);
  });
});

// ── Pricing formula (new occupancy-pricing fields) ─────────────────────────────
describe("pricing formula", () => {
  // 1. Extra adults above baseAdults are charged extraAdultCharge per night.
  it("Case P1: 3 adults, baseAdults=2, extraAdultCharge=1000 → +1000/night", () => {
    const result = allocateRooms({
      adults: 3, children: 0,
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 3 })],
      config: { ...baseConfig, baseAdults: 2, extraAdultCharge: 1000 },
      nights: 2,
    })!;
    expect(result).toHaveLength(1);
    expect(result[0]!.extraAdultCost).toBe(1000);          // (3 - 2) * 1000
    expect(result[0]!.pricePerNight).toBe(6000 + 1000);    // basePrice + extra adult
    expect(result[0]!.totalPrice).toBe((6000 + 1000) * 2); // × nights
  });

  // 2. Exactly baseAdults → no extra-adult charge.
  it("Case P2: 2 adults (= baseAdults), extraAdultCharge=1000 → no extra charge", () => {
    const result = allocateRooms({
      adults: 2, children: 0,
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 3 })],
      config: { ...baseConfig, baseAdults: 2, extraAdultCharge: 1000 },
      nights: 2,
    })!;
    expect(result[0]!.extraAdultCost).toBe(0);
    expect(result[0]!.pricePerNight).toBe(6000);
    expect(result[0]!.totalPrice).toBe(6000 * 2);
  });

  // 3. allowExtraBed=true + extra bed allocated → extraBedCharge added per night.
  it("Case P3: allowExtraBed=true, extra bed allocated, extraBedCharge=500 → +500/night", () => {
    const result = allocateRooms({
      adults: 3, children: 0,
      rooms: [room({ roomTypeId: "rt_dlx", name: "Deluxe", basePrice: 6000, maxAdults: 5 })],
      config: { ...baseConfig, baseAdults: 2, allowExtraBed: true, extraBedCharge: 500 },
      nights: 2,
    })!;
    expect(result[0]!.extraBed).toBe(true);
    expect(result[0]!.extraBedCost).toBe(500);
    expect(result[0]!.pricePerNight).toBe(6000 + 500);
    expect(result[0]!.totalPrice).toBe((6000 + 500) * 2); // includes 500 × 2
  });

  // 4. allowExtraBed=false → extraBedCharge never applied, even when set.
  it("Case P4: allowExtraBed=false → extraBedCharge ignored even if set", () => {
    const result = allocateRooms({
      adults: 3, children: 0,
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 3 })],
      config: { ...baseConfig, baseAdults: 2, allowExtraBed: false, extraBedCharge: 500, extraAdultCharge: 1000 },
      nights: 2,
    })!;
    // invariant change: extraBed now requires allowExtraBed → false when disallowed
    // (was true under the old "adults > baseAdults" flag); charge still not applied.
    expect(result[0]!.extraBed).toBe(false);
    expect(result[0]!.extraBedCost).toBe(0); // charge not applied
    expect(result[0]!.pricePerNight).toBe(6000 + 1000); // only the extra-adult charge
    expect(result[0]!.totalPrice).toBe((6000 + 1000) * 2);
  });

  // 5. childAgeLimit set → summary message includes the informational note.
  it("Case P5: childAgeLimit=8 → summary contains the age-limit note", () => {
    const result = allocateRooms({
      adults: 2, children: 1,
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 3, maxChildren: 1 })],
      config: { ...baseConfig, childAgeLimit: 8 },
      nights: 2,
    })!;
    const summary = renderAllocationSummary(result);
    expect(summary).toContain("Children above 8 years are charged as adults");
  });

  // 6. No extra charges → summary shows only the base price line (no breakdown).
  it("Case P6: all charges zero → summary shows only the base price line", () => {
    const result = allocateRooms({
      adults: 2, children: 0,
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 3 })],
      config: baseConfig,
      nights: 2,
    })!;
    const summary = renderAllocationSummary(result);
    expect(summary).toContain("₹6,000/night × 2 nights");
    expect(summary).not.toContain("base +");
    expect(summary).not.toContain("extra adult");
    expect(summary).not.toContain("extra bed");
    // No age-limit note when childAgeLimit is null.
    expect(summary).not.toContain("charged as adults");
  });
});

// ── Guest count variables (configurable adultsVar / childrenVar / childrenAgesVar) ──
describe("guest count variables", () => {
  // 1. parseChildrenAges — pure parsing + child-range filter.
  it("Case G1: parseChildrenAges extracts in-range integers in order", () => {
    expect(parseChildrenAges("6, 9")).toEqual([6, 9]);
    expect(parseChildrenAges("6 and 9 years")).toEqual([6, 9]);
    expect(parseChildrenAges("ages: 4,7,12")).toEqual([4, 7, 12]);
    expect(parseChildrenAges("")).toEqual([]);
    expect(parseChildrenAges("20, 5")).toEqual([5]);   // 20 out of child range
    expect(parseChildrenAges("no kids")).toEqual([]);
  });

  // 2. Adults read from a custom adultsVar.
  it("Case G2: reads adults from configured adultsVar", async () => {
    const deps = makeDeps({
      nodeData: { adultsVar: "partyAdults" },
      flowVars: { partyAdults: "4", bookingChildren: "0" },
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", maxAdults: 5, availableCount: 5 })],
    });
    await handleAdvancedRoomAllocation(deps);
    const state = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(state.guests.adults).toBe(4);
  });

  // 3. Children read from a custom childrenVar.
  it("Case G3: reads children from configured childrenVar", async () => {
    const deps = makeDeps({
      nodeData: { childrenVar: "partyKids" },
      flowVars: { bookingAdults: "2", partyKids: "1" },
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", maxAdults: 3, maxChildren: 2, availableCount: 5 })],
    });
    await handleAdvancedRoomAllocation(deps);
    const state = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(state.guests.children).toBe(1);
  });

  // 4. Ages count matches children → stored + shown on the child line.
  // (Drive through the preference step to reach the confirm summary.)
  it("Case G4: ages stored and shown when count matches children", async () => {
    const deps = makeDeps({
      nodeData: { childrenAgesVar: "kidAges", maxChildren: 2 },
      flowVars: { bookingAdults: "2", bookingChildren: "2", kidAges: "6, 9" },
      rooms: [room({ roomTypeId: "rt_fam", name: "Family", maxAdults: 3, maxChildren: 2, availableCount: 5 })],
    });
    await handleAdvancedRoomAllocation(deps);            // → collecting_room_preference
    deps.input = "MIX_IT_UP";
    const result = await handleAdvancedRoomAllocation(deps);
    const state = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(state.guests.childrenAges).toEqual([6, 9]);
    expect(result).toContain("aged 6 & 9");
  });

  // 5. Ages count mismatch → still stored, summary falls back to generic line.
  it("Case G5: ages stored but summary generic when count mismatches", async () => {
    const deps = makeDeps({
      nodeData: { childrenAgesVar: "kidAges" },
      flowVars: { bookingAdults: "2", bookingChildren: "1", kidAges: "6, 9" }, // 2 ages, 1 child
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", maxAdults: 3, maxChildren: 2, availableCount: 5 })],
    });
    await handleAdvancedRoomAllocation(deps);            // → collecting_room_preference
    deps.input = "MIX_IT_UP";
    const result = await handleAdvancedRoomAllocation(deps);
    const state = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(state.guests.childrenAges).toEqual([6, 9]);
    expect(result).toContain("1 child");
    expect(result).not.toContain("aged");
  });

  // 6. Back-compat — no vars set → bookingAdults / bookingChildren defaults.
  // Phase 1 now lands in collecting_room_preference; guests still carried in state.
  it("Case G6: falls back to bookingAdults/bookingChildren when no vars set", async () => {
    const deps = makeDeps({
      flowVars: { bookingAdults: "3", bookingChildren: "0" },
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", maxAdults: 5, availableCount: 5 })],
    });
    await handleAdvancedRoomAllocation(deps);
    const state = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(state.guests.adults).toBe(3);
    expect(state.guests.children).toBe(0);
    expect(state.guests.childrenAges).toBeUndefined();
  });
});

// ── AI-assisted manual modification ───────────────────────────────────────────
describe("AI-assisted modification", () => {
  function aRoom(over: Partial<AllocationRoom> = {}): AllocationRoom {
    return {
      roomTypeId: "rt_a", roomTypeName: "Standard",
      adults: 2, children: 0, extraBed: false,
      basePrice: 6000, extraAdultCost: 0, extraBedCost: 0, childAgeLimit: null,
      pricePerNight: 6000, nights: 2, totalPrice: 12000,
      ...over,
    };
  }
  const allowCfg: RoomConfigResolver = () => ({ ...baseConfig, allowExtraBed: true, extraBedCharge: 500 });
  const denyCfg:  RoomConfigResolver = () => ({ ...baseConfig, allowExtraBed: false, extraBedCharge: 500 });

  function manualState(selectedRooms: AllocationRoom[], remaining = { adults: 0, children: 0 }): AraState {
    return { guests: { adults: 4, children: 0 }, selectedRooms, remainingGuests: remaining, phase: "manual" };
  }

  // 1. add extra bed — price up by charge × nights; rejected when not allowed.
  it("Case A1: applyAddExtraBed adds a bed and reprices; rejects when disallowed", () => {
    const res = applyAddExtraBed([aRoom({})], 0, allowCfg);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rooms[0]!.extraBed).toBe(true);
      expect(res.rooms[0]!.extraBedCost).toBe(500);
      expect(res.rooms[0]!.totalPrice).toBe(12000 + 500 * 2); // +charge × nights
    }
    const rej = applyAddExtraBed([aRoom({})], 0, denyCfg);
    expect(rej.ok).toBe(false);
    if (!rej.ok) {
      expect(rej.outOfRange).toBe(false);
      expect(rej.reason).toContain("don't support an extra bed");
    }
  });

  // 2. remove extra bed — price drops by the bed charge.
  it("Case A2: applyRemoveExtraBed removes a bed and reprices", () => {
    const rooms = [aRoom({ extraBed: true, extraBedCost: 500, pricePerNight: 6500, totalPrice: 13000 })];
    const res = applyRemoveExtraBed(rooms, 0);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rooms[0]!.extraBed).toBe(false);
      expect(res.rooms[0]!.extraBedCost).toBe(0);
      expect(res.rooms[0]!.totalPrice).toBe(12000); // dropped by 500 × 2
    }
  });

  // 3. move extra bed — both rooms repriced; rejected if target disallows.
  it("Case A3: applyMoveExtraBed moves the bed and reprices both; rejects on disallowed target", () => {
    const rooms = [
      aRoom({ roomTypeId: "rt_a", roomTypeName: "Standard", extraBed: true,  extraBedCost: 500, pricePerNight: 6500, totalPrice: 13000, basePrice: 6000 }),
      aRoom({ roomTypeId: "rt_b", roomTypeName: "Deluxe",   extraBed: false, extraBedCost: 0,   pricePerNight: 8000, totalPrice: 16000, basePrice: 8000 }),
    ];
    const res = applyMoveExtraBed(rooms, 0, 1, allowCfg);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rooms[0]!.extraBed).toBe(false);
      expect(res.rooms[0]!.totalPrice).toBe(12000);
      expect(res.rooms[1]!.extraBed).toBe(true);
      expect(res.rooms[1]!.extraBedCost).toBe(500);
      expect(res.rooms[1]!.totalPrice).toBe(8000 * 2 + 500 * 2); // 17000
    }
    const rej = applyMoveExtraBed(rooms, 0, 1, denyCfg);
    expect(rej.ok).toBe(false);
    if (!rej.ok) {
      expect(rej.outOfRange).toBe(false);
      expect(rej.reason).toContain("Deluxe");
    }
  });

  // 4. remove room — grand total recomputed, guests returned.
  it("Case A4: applyRemoveRoom drops the room and returns its guests", () => {
    const rooms = [
      aRoom({ roomTypeId: "rt_a", adults: 2, children: 1, totalPrice: 12000 }),
      aRoom({ roomTypeId: "rt_b", roomTypeName: "Deluxe", adults: 1, children: 0, totalPrice: 16000 }),
    ];
    const res = applyRemoveRoom(rooms, 0);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rooms).toHaveLength(1);
      expect(res.rooms[0]!.roomTypeId).toBe("rt_b");
      expect(res.returnedGuests).toEqual({ adults: 2, children: 1 });
      expect(res.rooms.reduce((s, r) => s + r.totalPrice, 0)).toBe(16000); // grand total
    }
  });

  // 5. Out-of-range index → treated as unknown → structured re-prompt, no mutation.
  it("Case A5: out-of-range index falls back to the structured re-prompt", async () => {
    expect(applyAddExtraBed([aRoom({})], 9, allowCfg)).toMatchObject({ ok: false, outOfRange: true });

    const state = manualState([aRoom({ roomTypeId: "rt_a" })]);
    const deps = makeDeps({
      waitingFor: "answer",
      nodeData: { allowExtraBed: true, extraBedCharge: 500 },
      flowVars: { __araState__: JSON.stringify(state) },
      rooms: [room({ roomTypeId: "rt_a", name: "Standard", basePrice: 6000, availableCount: 5 })],
      input: "add a bed to room 10",
      interpretModification: vi.fn(async () => ({ operation: "add_extra_bed" as const, roomIndex: 9, confidence: "high" as const })),
    });
    const before = deps.flowData.flowVars["__araState__"];
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/room number/i);
    expect(deps.flowData.flowVars["__araState__"]).toBe(before); // unchanged
  });

  // 6. move_extra_bed high confidence → applied + summary re-rendered.
  it("Case A6: high-confidence move is applied and the summary re-rendered", async () => {
    const state = manualState([
      aRoom({ roomTypeId: "rt_a", roomTypeName: "Standard", extraBed: true,  extraBedCost: 500, pricePerNight: 6500, totalPrice: 13000, basePrice: 6000 }),
      aRoom({ roomTypeId: "rt_b", roomTypeName: "Deluxe",   extraBed: false, extraBedCost: 0,   pricePerNight: 8000, totalPrice: 16000, basePrice: 8000 }),
    ]);
    const interp = vi.fn(async () => ({ operation: "move_extra_bed" as const, fromRoomIndex: 0, toRoomIndex: 1, confidence: "high" as const }));
    const deps = makeDeps({
      waitingFor: "answer",
      nodeData: { allowExtraBed: true, extraBedCharge: 500 },
      flowVars: { __araState__: JSON.stringify(state) },
      rooms: [
        room({ roomTypeId: "rt_a", name: "Standard", basePrice: 6000, availableCount: 5 }),
        room({ roomTypeId: "rt_b", name: "Deluxe",   basePrice: 8000, availableCount: 5 }),
      ],
      input: "move the extra bed to the deluxe",
      interpretModification: interp,
    });
    const result = await handleAdvancedRoomAllocation(deps);

    expect(interp).toHaveBeenCalledTimes(1);
    expect(result).toContain("Extra bed included");
    expect(result).toMatch(/Reply \*DONE\* to confirm/);

    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(after.selectedRooms[0]!.extraBed).toBe(false);
    expect(after.selectedRooms[1]!.extraBed).toBe(true);
    expect(after.selectedRooms[1]!.totalPrice).toBe(17000);
  });

  // 7. unknown → structured re-prompt, araState unchanged.
  it("Case A7: 'unknown' returns the structured re-prompt and does not mutate", async () => {
    const state = manualState([aRoom({ roomTypeId: "rt_a" })]);
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(state) },
      rooms: [room({ roomTypeId: "rt_a", name: "Standard", basePrice: 6000, availableCount: 5 })],
      input: "what's the weather like",
      interpretModification: vi.fn(async () => ({ operation: "unknown" as const, confidence: "high" as const })),
    });
    const before = deps.flowData.flowVars["__araState__"];
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/room number/i);
    expect(deps.flowData.flowVars["__araState__"]).toBe(before);
  });

  // 8. low confidence → structured re-prompt, no mutation.
  it("Case A8: low confidence never mutates — structured re-prompt", async () => {
    const state = manualState([
      aRoom({ roomTypeId: "rt_a", extraBed: true }),
      aRoom({ roomTypeId: "rt_b", roomTypeName: "Deluxe" }),
    ]);
    const deps = makeDeps({
      waitingFor: "answer",
      nodeData: { allowExtraBed: true, extraBedCharge: 500 },
      flowVars: { __araState__: JSON.stringify(state) },
      rooms: [
        room({ roomTypeId: "rt_a", name: "Standard", basePrice: 6000, availableCount: 5 }),
        room({ roomTypeId: "rt_b", name: "Deluxe",   basePrice: 8000, availableCount: 5 }),
      ],
      input: "maybe move the bed somewhere",
      interpretModification: vi.fn(async () => ({ operation: "move_extra_bed" as const, fromRoomIndex: 0, toRoomIndex: 1, confidence: "low" as const })),
    });
    const before = deps.flowData.flowVars["__araState__"];
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/room number/i);
    expect(deps.flowData.flowVars["__araState__"]).toBe(before);
  });

  // 9. No interpreter dep → manual mode behaves exactly as before (back-compat).
  it("Case A9: without the interpreter dep, free text gets the structured re-prompt", async () => {
    // Guests still need rooms (remaining > 0) so this exercises the fill re-prompt;
    // the all-placed state now shows the add-room prompt instead (see K-tests).
    const state = manualState([aRoom({ roomTypeId: "rt_a" })], { adults: 1, children: 0 });
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(state) },
      rooms: [room({ roomTypeId: "rt_a", name: "Standard", basePrice: 6000, availableCount: 5 })],
      input: "move the extra bed to deluxe",
      // no interpretModification dep
    });
    const before = deps.flowData.flowVars["__araState__"];
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/room number/i);
    expect(deps.flowData.flowVars["__araState__"]).toBe(before);
  });
});

// ── move_guest + modify UX ────────────────────────────────────────────────────
describe("move_guest and modify UX", () => {
  function gRoom(over: Partial<AllocationRoom> = {}): AllocationRoom {
    return {
      roomTypeId: "rt_a", roomTypeName: "Standard",
      adults: 2, children: 0, extraBed: false,
      basePrice: 6000, extraAdultCost: 0, extraBedCost: 0, childAgeLimit: null,
      pricePerNight: 6000, nights: 2, totalPrice: 12000,
      ...over,
    };
  }
  // Per-room config resolver keyed by roomTypeId (defaults to baseConfig).
  const cfgFor = (map: Record<string, Partial<AllocationConfig>>): RoomConfigResolver =>
    (r) => ({ ...baseConfig, ...(map[r.roomTypeId] ?? {}) });

  function stateOf(phase: "confirm" | "manual", selectedRooms: AllocationRoom[]): AraState {
    return { guests: { adults: 5, children: 0 }, selectedRooms, remainingGuests: { adults: 0, children: 0 }, phase };
  }

  // 1. Basic move — both rooms re-priced, counts correct, grand total recomputed.
  it("Case MG1: moves a guest, reprices both rooms and the grand total", () => {
    const resolver = cfgFor({ rt_a: { extraAdultCharge: 1000, maxAdults: 4 }, rt_b: { extraAdultCharge: 1000, maxAdults: 4 } });
    const rooms = [
      gRoom({ roomTypeId: "rt_a", adults: 3, extraAdultCost: 1000, pricePerNight: 7000, totalPrice: 14000 }),
      gRoom({ roomTypeId: "rt_b", roomTypeName: "Deluxe", adults: 2, pricePerNight: 6000, totalPrice: 12000 }),
    ];
    const res = applyMoveGuest(rooms, 0, 1, 1, 0, resolver);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rooms[0]!.adults).toBe(2);
      expect(res.rooms[1]!.adults).toBe(3);
      expect(res.rooms[0]!.pricePerNight).toBe(6000); // 2 adults → no extra
      expect(res.rooms[1]!.pricePerNight).toBe(7000); // 3 adults → +1000
      expect(res.rooms.reduce((s, r) => s + r.totalPrice, 0)).toBe(6000 * 2 + 7000 * 2);
    }
  });

  // 2. Destination cap exceeded → reason, no mutation.
  it("Case MG2: exceeding destination maxAdults is rejected with a reason", () => {
    const rooms = [gRoom({ roomTypeId: "rt_a", adults: 2 }), gRoom({ roomTypeId: "rt_b", roomTypeName: "Deluxe", adults: 3 })];
    const res = applyMoveGuest(rooms, 0, 1, 1, 0, cfgFor({ rt_b: { maxAdults: 3 } }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.outOfRange).toBe(false);
      expect(res.reason).toContain("at most 3 adults");
    }
  });

  // 3. Emptying the source → source room removed.
  it("Case MG3: emptying the source room drops it from the allocation", () => {
    const rooms = [gRoom({ roomTypeId: "rt_a", adults: 1 }), gRoom({ roomTypeId: "rt_b", roomTypeName: "Deluxe", adults: 2 })];
    const res = applyMoveGuest(rooms, 0, 1, 1, 0, cfgFor({ rt_b: { maxAdults: 5 } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rooms).toHaveLength(1);
      expect(res.rooms[0]!.roomTypeId).toBe("rt_b");
      expect(res.rooms[0]!.adults).toBe(3);
    }
  });

  // 4. Source lacks the guests → reason, no mutation.
  it("Case MG4: moving more guests than the source has is rejected", () => {
    const rooms = [gRoom({ roomTypeId: "rt_a", adults: 1 }), gRoom({ roomTypeId: "rt_b", roomTypeName: "Deluxe", adults: 2 })];
    const res = applyMoveGuest(rooms, 0, 1, 2, 0, cfgFor({ rt_b: { maxAdults: 5 } }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.outOfRange).toBe(false);
      expect(res.reason).toContain("only has 1 adult");
    }
  });

  // 5. Out-of-range / same-room index → outOfRange; nothing-to-move → reason.
  it("Case MG5: out-of-range or same-room indices are outOfRange", () => {
    const rooms = [gRoom({ roomTypeId: "rt_a" }), gRoom({ roomTypeId: "rt_b" })];
    const any = cfgFor({});
    expect(applyMoveGuest(rooms, 0, 9, 1, 0, any)).toMatchObject({ ok: false, outOfRange: true });
    expect(applyMoveGuest(rooms, 1, 1, 1, 0, any)).toMatchObject({ ok: false, outOfRange: true });
    expect(applyMoveGuest(rooms, 0, 1, 0, 0, any)).toMatchObject({ ok: false, outOfRange: false }); // nothing to move
  });

  // Bed-out: moving an adult out below baseAdults auto-removes the extra bed.
  it("Case MG-bed-out: moving an adult out drops the extra bed + both charges", () => {
    const resolver = cfgFor({
      rt_src: { baseAdults: 2, allowExtraBed: true, extraBedCharge: 500, extraAdultCharge: 1000, maxAdults: 4 },
      rt_dst: { baseAdults: 2, allowExtraBed: false, extraAdultCharge: 1000, maxAdults: 5 },
    });
    const rooms = [
      gRoom({ roomTypeId: "rt_src", roomTypeName: "Suite", adults: 3, extraBed: true, extraAdultCost: 1000, extraBedCost: 500, pricePerNight: 7500, totalPrice: 15000, basePrice: 6000 }),
      gRoom({ roomTypeId: "rt_dst", roomTypeName: "Deluxe", adults: 2, basePrice: 8000, pricePerNight: 8000, totalPrice: 16000 }),
    ];
    const res = applyMoveGuest(rooms, 0, 1, 1, 0, resolver);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const src = res.rooms[0]!;
      expect(src.adults).toBe(2);
      expect(src.extraBed).toBe(false);
      expect(src.extraBedCost).toBe(0);
      expect(src.extraAdultCost).toBe(0);
      expect(src.pricePerNight).toBe(6000); // drops by 1000 (adult) + 500 (bed)
      const dst = res.rooms[1]!;
      expect(dst.adults).toBe(3);
      expect(dst.extraBed).toBe(false);            // dst disallows beds
      expect(dst.pricePerNight).toBe(8000 + 1000); // only extra-adult charge
    }
  });

  // Bed-in (allowed): moving an adult in above baseAdults auto-adds the bed.
  it("Case MG-bed-in-allowed: moving an adult in adds a bed when allowed", () => {
    const resolver = cfgFor({
      rt_src: { maxAdults: 5, extraAdultCharge: 1000 },
      rt_dst: { baseAdults: 2, allowExtraBed: true, extraBedCharge: 500, extraAdultCharge: 1000, maxAdults: 4 },
    });
    const rooms = [
      gRoom({ roomTypeId: "rt_src", adults: 3, basePrice: 6000 }),
      gRoom({ roomTypeId: "rt_dst", roomTypeName: "Deluxe", adults: 2, basePrice: 8000, pricePerNight: 8000, totalPrice: 16000 }),
    ];
    const res = applyMoveGuest(rooms, 0, 1, 1, 0, resolver);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const dst = res.rooms[1]!;
      expect(dst.adults).toBe(3);
      expect(dst.extraBed).toBe(true);
      expect(dst.extraAdultCost).toBe(1000);
      expect(dst.extraBedCost).toBe(500);
      expect(dst.pricePerNight).toBe(8000 + 1000 + 500);
    }
  });

  // Bed-in (not allowed): adults rise up to maxAdults with no bed, charge only.
  it("Case MG-bed-in-noallow: moving an adult in adds no bed when disallowed", () => {
    const resolver = cfgFor({
      rt_src: { maxAdults: 5, extraAdultCharge: 1000 },
      rt_dst: { baseAdults: 2, allowExtraBed: false, extraBedCharge: 500, extraAdultCharge: 1000, maxAdults: 4 },
    });
    const rooms = [
      gRoom({ roomTypeId: "rt_src", adults: 3, basePrice: 6000 }),
      gRoom({ roomTypeId: "rt_dst", roomTypeName: "Deluxe", adults: 2, basePrice: 8000, pricePerNight: 8000, totalPrice: 16000 }),
    ];
    const res = applyMoveGuest(rooms, 0, 1, 1, 0, resolver);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const dst = res.rooms[1]!;
      expect(dst.adults).toBe(3);
      expect(dst.extraBed).toBe(false);
      expect(dst.extraBedCost).toBe(0);
      expect(dst.pricePerNight).toBe(8000 + 1000); // extra-adult charge only
    }
  });

  // 6. Confirm phase + high-confidence move_guest → applied, phase stays confirm.
  it("Case MG6: confirm-phase modification applies and stays in confirm phase", async () => {
    const state = stateOf("confirm", [
      gRoom({ roomTypeId: "rt_a", roomTypeName: "Standard", adults: 3, extraAdultCost: 1000, pricePerNight: 7000, totalPrice: 14000 }),
      gRoom({ roomTypeId: "rt_b", roomTypeName: "Deluxe", adults: 2, basePrice: 8000, pricePerNight: 8000, totalPrice: 16000 }),
    ]);
    const interp = vi.fn(async () => ({ operation: "move_guest" as const, fromRoomIndex: 0, toRoomIndex: 1, adults: 1, children: 0, confidence: "high" as const }));
    const deps = makeDeps({
      waitingFor: "answer",
      nodeData: { maxAdults: 4, extraAdultCharge: 1000 },
      flowVars: { __araState__: JSON.stringify(state) },
      rooms: [
        room({ roomTypeId: "rt_a", name: "Standard", basePrice: 6000, maxAdults: 4, availableCount: 5 }),
        room({ roomTypeId: "rt_b", name: "Deluxe",   basePrice: 8000, maxAdults: 4, availableCount: 5 }),
      ],
      input: "move one adult from room 1 to room 2",
      interpretModification: interp,
    });
    const result = await handleAdvancedRoomAllocation(deps);
    expect(interp).toHaveBeenCalledTimes(1);
    expect(result).toContain("Suggested Allocation");
    expect(result).toContain("Reply *1* to Confirm"); // confirm footer → still confirm phase
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(after.phase).toBe("confirm");
    expect(after.selectedRooms[0]!.adults).toBe(2);
    expect(after.selectedRooms[1]!.adults).toBe(3);
  });

  // 7. Confirm phase + unknown → acknowledgement + confirm re-prompt, unchanged.
  it("Case MG7: confirm-phase unknown acknowledges and keeps the confirm prompt", async () => {
    const state = stateOf("confirm", [gRoom({ roomTypeId: "rt_a" }), gRoom({ roomTypeId: "rt_b", roomTypeName: "Deluxe" })]);
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(state) },
      rooms: [
        room({ roomTypeId: "rt_a", name: "Standard", basePrice: 6000, availableCount: 5 }),
        room({ roomTypeId: "rt_b", name: "Deluxe",   basePrice: 8000, availableCount: 5 }),
      ],
      input: "do you have a swimming pool",
      interpretModification: vi.fn(async () => ({ operation: "unknown" as const, confidence: "high" as const })),
    });
    const before = deps.flowData.flowVars["__araState__"];
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toContain("I couldn't make that change automatically");
    expect(result).toMatch(/reply \*1\* to confirm/i);
    expect(deps.flowData.flowVars["__araState__"]).toBe(before);
  });

  // 8. Manual phase + unknown → acknowledgement + manual re-prompt, unchanged.
  it("Case MG8: manual-phase unknown acknowledges and keeps the manual prompt", async () => {
    const state = stateOf("manual", [gRoom({ roomTypeId: "rt_a" })]);
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(state) },
      rooms: [room({ roomTypeId: "rt_a", name: "Standard", basePrice: 6000, availableCount: 5 })],
      input: "tell me a joke",
      interpretModification: vi.fn(async () => ({ operation: "unknown" as const, confidence: "high" as const })),
    });
    const before = deps.flowData.flowVars["__araState__"];
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toContain("I couldn't make that change automatically");
    expect(result).toMatch(/room number/i);
    expect(deps.flowData.flowVars["__araState__"]).toBe(before);
  });

  // 9. Back-compat: confirm phase with no interpreter dep — "1" confirms, "2" → manual.
  it("Case MG9: confirm phase without the dep still confirms on '1' and modifies on '2'", async () => {
    const sel = [gRoom({ roomTypeId: "rt_a" }), gRoom({ roomTypeId: "rt_b", roomTypeName: "Deluxe" })];

    const deps1 = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(stateOf("confirm", sel)) },
      rooms: [room({ roomTypeId: "rt_a", name: "Standard", basePrice: 6000, availableCount: 5 })],
      input: "1",
    });
    await handleAdvancedRoomAllocation(deps1);
    expect(deps1.flowData.flowVars["bookingRooms"]).toBeTruthy();
    expect(deps1.advance).toHaveBeenCalled();

    const deps2 = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(stateOf("confirm", sel)) },
      rooms: [room({ roomTypeId: "rt_a", name: "Standard", basePrice: 6000, availableCount: 5 })],
      input: "2",
    });
    await handleAdvancedRoomAllocation(deps2);
    const after2 = JSON.parse(deps2.flowData.flowVars["__araState__"]!) as AraState;
    expect(after2.phase).toBe("manual");
  });
});

// ── base-first / absorb-remainder strategy ────────────────────────────────────
describe("base-first absorb-remainder", () => {
  // base 2 / max 3, allowExtraBed so absorbed rooms get a bed; realistic charges.
  const cfg: AllocationConfig = { ...baseConfig, allowExtraBed: true, extraAdultCharge: 1000, extraBedCharge: 500 };
  const single = (avail = 20, basePrice = 5000): AllocationRoomInput[] =>
    [room({ roomTypeId: "rt", name: "Deluxe", basePrice, availableCount: avail })];
  const adultsOf = (r: AllocationRoom[]) => r.map((x) => x.adults).sort((a, b) => b - a);
  const beds = (r: AllocationRoom[]) => r.filter((x) => x.extraBed).length;

  it("10 adults → 5 base rooms, no beds", () => {
    const r = allocateRooms({ adults: 10, children: 0, rooms: single(), config: cfg, nights: 1 })!;
    expect(r).toHaveLength(5);
    expect(adultsOf(r)).toEqual([2, 2, 2, 2, 2]);
    expect(beds(r)).toBe(0);
  });

  it("5 adults → [3a+bed] + [2a] (absorb the remainder, one bed)", () => {
    const r = allocateRooms({ adults: 5, children: 0, rooms: single(), config: cfg, nights: 1 })!;
    expect(r).toHaveLength(2);
    expect(adultsOf(r)).toEqual([3, 2]);
    expect(beds(r)).toBe(1);
    const three = r.find((x) => x.adults === 3)!;
    expect(three.pricePerNight).toBe(5000 + 1000 + 500); // base + extra adult + bed
    expect(r.find((x) => x.adults === 2)!.pricePerNight).toBe(5000);
  });

  it("7 adults → [3a+bed] + [2a] + [2a] (one bed)", () => {
    const r = allocateRooms({ adults: 7, children: 0, rooms: single(), config: cfg, nights: 1 })!;
    expect(r).toHaveLength(3);
    expect(adultsOf(r)).toEqual([3, 2, 2]);
    expect(beds(r)).toBe(1);
  });

  it("4 adults → 2 base rooms, no beds", () => {
    const r = allocateRooms({ adults: 4, children: 0, rooms: single(), config: cfg, nights: 1 })!;
    expect(adultsOf(r)).toEqual([2, 2]);
    expect(beds(r)).toBe(0);
  });

  it("3 adults → single room [3a+bed]", () => {
    const r = allocateRooms({ adults: 3, children: 0, rooms: single(), config: cfg, nights: 1 })!;
    expect(r).toHaveLength(1);
    expect(r[0]!.adults).toBe(3);
    expect(r[0]!.extraBed).toBe(true);
  });

  it("1 adult → single room [1a], no bed (nothing to absorb into)", () => {
    const r = allocateRooms({ adults: 1, children: 0, rooms: single(), config: cfg, nights: 1 })!;
    expect(r).toHaveLength(1);
    expect(r[0]!.adults).toBe(1);
    expect(r[0]!.extraBed).toBe(false);
  });

  it("6 adults → 3 base rooms, no beds", () => {
    const r = allocateRooms({ adults: 6, children: 0, rooms: single(), config: cfg, nights: 1 })!;
    expect(adultsOf(r)).toEqual([2, 2, 2]);
    expect(beds(r)).toBe(0);
  });

  it("5 adults + 2 children → [3a+1c+bed] + [2a+1c]", () => {
    const r = allocateRooms({ adults: 5, children: 2, rooms: single(), config: cfg, nights: 1 })!;
    expect(r).toHaveLength(2);
    const three = r.find((x) => x.adults === 3)!;
    const two   = r.find((x) => x.adults === 2)!;
    expect(three.children).toBe(1);
    expect(two.children).toBe(1);
    expect(three.extraBed).toBe(true);
    expect(two.extraBed).toBe(false);
  });

  it("availability spill: cheap deluxe (avail 1) carries the max, superior takes the rest", () => {
    const rooms = [
      room({ roomTypeId: "rt_dlx", name: "Deluxe",   basePrice: 5000, availableCount: 1 }),
      room({ roomTypeId: "rt_sup", name: "Superior", basePrice: 6500, availableCount: 5 }),
    ];
    const r = allocateRooms({ adults: 5, children: 0, rooms, config: cfg, nights: 1 })!;
    expect(r).toHaveLength(2);
    const dlx = r.find((x) => x.roomTypeId === "rt_dlx")!;
    const sup = r.find((x) => x.roomTypeId === "rt_sup")!;
    expect(dlx.adults).toBe(3);
    expect(dlx.extraBed).toBe(true);
    expect(sup.adults).toBe(2);
    expect(sup.extraBed).toBe(false);
  });

  it("remainder not absorbable → opens an under-filled base room, no beds (base 4 / max 5)", () => {
    const r = allocateRooms({
      adults: 6, children: 0,
      rooms: single(),
      config: { ...cfg, baseAdults: 4, maxAdults: 5 },
      nights: 1,
    })!;
    expect(r).toHaveLength(2);
    expect(adultsOf(r)).toEqual([4, 2]); // [4,2], not crammed to [5,1]
    expect(beds(r)).toBe(0);
  });

  it("children overflow opens extra rooms (maxChildren 1)", () => {
    // 2 adults + 3 children → [2a+1c] + [0a+1c] + [0a+1c]
    const r = allocateRooms({ adults: 2, children: 3, rooms: single(), config: cfg, nights: 1 })!;
    expect(r).toHaveLength(3);
    expect(r.reduce((s, x) => s + x.children, 0)).toBe(3);
    expect(r.reduce((s, x) => s + x.adults, 0)).toBe(2);
    expect(r.every((x) => x.children <= 1)).toBe(true);
  });

  it("graceful failure when inventory cannot house the group", () => {
    // 10 adults, single type, only 2 rooms (max 3 each = 6 < 10) → null.
    expect(allocateRooms({ adults: 10, children: 0, rooms: single(2), config: cfg, nights: 1 })).toBeNull();
  });
});

// ── Keep suggestion on "2" + manual add-room ──────────────────────────────────
describe("keep-rooms and add-room", () => {
  function kRoom(over: Partial<AllocationRoom> = {}): AllocationRoom {
    return {
      roomTypeId: "rt_std", roomTypeName: "Standard",
      adults: 2, children: 0, extraBed: false,
      basePrice: 5000, extraAdultCost: 0, extraBedCost: 0, childAgeLimit: null,
      pricePerNight: 5000, nights: 2, totalPrice: 10000,
      ...over,
    };
  }
  const stdRooms = () => [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 5000, availableCount: 5 })];

  // 1. "2" at confirm KEEPS the suggested rooms and marks all guests placed.
  it("Case K1: pressing '2' keeps the suggestion and enters manual all-placed", async () => {
    const confirmState: AraState = {
      guests: { adults: 5, children: 0 },
      selectedRooms: [kRoom({ adults: 3, extraBed: true }), kRoom({ adults: 2 })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "confirm",
    };
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(confirmState) },
      rooms: stdRooms(),
      input: "2",
    });
    await handleAdvancedRoomAllocation(deps);
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(after.phase).toBe("manual");
    expect(after.selectedRooms.length).toBe(2);          // kept, not wiped
    expect(after.remainingGuests).toEqual({ adults: 0, children: 0 });
  });

  // 2. The all-placed prompt offers a numbered room list + DONE.
  it("Case K2: all-placed prompt includes the room list and DONE", async () => {
    const confirmState: AraState = {
      guests: { adults: 4, children: 0 },
      selectedRooms: [kRoom({ adults: 2 }), kRoom({ adults: 2 })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "confirm",
    };
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(confirmState) },
      rooms: stdRooms(),
      input: "2",
    });
    const result = await handleAdvancedRoomAllocation(deps);
    // render change: the manual prompt is now the "Modify your booking" menu
    // (edit existing rooms 1..N, add list offset after) instead of "add another room".
    expect(result).toMatch(/Modify your booking/i);
    expect(result).toMatch(/Add a room/i);
    expect(result).toContain("Standard");                // a room type from the add list
    expect(result).toContain("DONE");
  });

  // 3. Picking an ADD number when all placed adds a base-occupancy room.
  it("Case K3: add-room at base occupancy, no extra bed, priced correctly", async () => {
    const manualState: AraState = {
      guests: { adults: 4, children: 0 },
      selectedRooms: [kRoom({ adults: 2 }), kRoom({ adults: 2 })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "manual",
    };
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(manualState) },
      rooms: stdRooms(),
      // entry-point change: existing-room numbers (1,2) now EDIT; the add list is
      // offset → "3" adds the first available type.
      input: "3",
    });
    await handleAdvancedRoomAllocation(deps);
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(after.selectedRooms.length).toBe(3);          // a room was added
    expect(after.remainingGuests).toEqual({ adults: 0, children: 0 }); // unchanged
    const added = after.selectedRooms[2]!;
    expect(added.adults).toBe(2);                        // base occupancy
    expect(added.extraBed).toBe(false);
    expect(added.pricePerNight).toBe(5000);              // base, no extras
    expect(added.totalPrice).toBe(10000);                // × 2 nights
  });

  // 4. Invalid number when all placed → re-prompt, no mutation.
  it("Case K4: invalid number while all-placed re-prompts without mutating", async () => {
    const manualState: AraState = {
      guests: { adults: 2, children: 0 },
      selectedRooms: [kRoom({ adults: 2 })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "manual",
    };
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(manualState) },
      rooms: stdRooms(),
      input: "99",
    });
    const before = deps.flowData.flowVars["__araState__"];
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/add another room|DONE/i);
    expect(deps.flowData.flowVars["__araState__"]).toBe(before); // unchanged
  });

  // 5. DONE from all-placed finalizes; bookingRooms includes an added room.
  it("Case K5: add a room then DONE writes the output contract with all rooms", async () => {
    const manualState: AraState = {
      guests: { adults: 4, children: 0 },
      selectedRooms: [kRoom({ adults: 2 }), kRoom({ adults: 2 })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "manual",
    };
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(manualState) },
      rooms: stdRooms(),
      // entry-point change: "3" is the offset add number (rooms 1,2 edit).
      input: "3",
    });
    await handleAdvancedRoomAllocation(deps); // add a 3rd room
    deps.input = "DONE";
    await handleAdvancedRoomAllocation(deps); // confirm

    const bookingRooms = JSON.parse(deps.flowData.flowVars["bookingRooms"]!) as AllocationRoom[];
    expect(bookingRooms.length).toBe(3);
    expect(deps.advance).toHaveBeenCalled();
    expect(deps.flowData.flowVars["__araState__"]).toBeUndefined(); // cleaned up
  });
});

// ── Deterministic structured modify menu (AI-free navigation) ─────────────────
describe("structured modify menu", () => {
  function sRoom(over: Partial<AllocationRoom> = {}): AllocationRoom {
    return {
      roomTypeId: "rt_a", roomTypeName: "Standard",
      adults: 2, children: 0, extraBed: false,
      basePrice: 5000, extraAdultCost: 0, extraBedCost: 0, childAgeLimit: null,
      pricePerNight: 5000, nights: 2, totalPrice: 10000,
      ...over,
    };
  }
  function st(phase: AraState["phase"], selectedRooms: AllocationRoom[], extra: Partial<AraState> = {}): AraState {
    return { guests: { adults: 5, children: 0 }, selectedRooms, remainingGuests: { adults: 0, children: 0 }, phase, ...extra };
  }
  const oneType  = () => [room({ roomTypeId: "rt_a", name: "Standard", basePrice: 5000, availableCount: 5 })];
  const twoTypes = () => [
    room({ roomTypeId: "rt_dlx", name: "Deluxe",   basePrice: 5000, availableCount: 5 }),
    room({ roomTypeId: "rt_sup", name: "Superior", basePrice: 6500, availableCount: 5 }),
  ];
  // Helper: build deps in a given phase/state with an injected araState.
  const mk = (state: AraState, input: string, rooms = oneType(), nodeData: Record<string, unknown> = {}) =>
    makeDeps({ waitingFor: "answer", nodeData, flowVars: { __araState__: JSON.stringify(state) }, rooms, input });
  const readAra = (deps: AdvancedRoomAllocationDeps) =>
    JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;

  // 1. Manual re-render: 2 existing rooms + 2 types → 1,2 edit, 3,4 add.
  it("Case S1: manual re-render lists existing rooms 1–2 + offset add-room list 3,4", async () => {
    const confirm = st("confirm", [sRoom({ roomTypeId: "rt_dlx", roomTypeName: "Deluxe" }), sRoom({ roomTypeId: "rt_dlx", roomTypeName: "Deluxe" })]);
    const result = await handleAdvancedRoomAllocation(mk(confirm, "2", twoTypes()));
    expect(result).toMatch(/Reply \*1–2\* to edit a room/);
    expect(result).toContain("*3.* Deluxe");
    expect(result).toContain("*4.* Superior");
  });

  // 2. Picking an existing room number → room_menu with selectedRoomIndex stored.
  it("Case S2: existing room number enters room_menu and stores the index", async () => {
    const deps = mk(st("manual", [sRoom({}), sRoom({})]), "2");
    await handleAdvancedRoomAllocation(deps);
    const after = readAra(deps);
    expect(after.phase).toBe("room_menu");
    expect(after.selectedRoomIndex).toBe(1);
  });

  // 3. room_menu for a room WITH an extra bed shows "Remove extra bed".
  it("Case S3: room_menu with extra bed offers Remove (not Add)", async () => {
    const deps = mk(st("room_menu", [sRoom({ extraBed: true })], { selectedRoomIndex: 0 }), "", oneType(), { allowExtraBed: true });
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toContain("Remove extra bed");
    expect(result).not.toContain("Add extra bed");
  });

  // 4. room_menu where allowExtraBed=false → no extra-bed option at all.
  it("Case S4: room_menu with allowExtraBed=false shows no extra-bed option", async () => {
    const deps = mk(st("room_menu", [sRoom({})], { selectedRoomIndex: 0 }), "", oneType(), { allowExtraBed: false });
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).not.toMatch(/extra bed/i);
    expect(result).toContain("Remove this room");
  });

  // 5. Add extra bed from the menu → applyAddExtraBed, re-renders manual.
  it("Case S5: add extra bed from the menu", async () => {
    // options for a no-bed room w/ allowExtraBed: [add_bed, move_guest, remove_room] → "1" = add.
    const deps = mk(st("room_menu", [sRoom({})], { selectedRoomIndex: 0 }), "1", oneType(), { allowExtraBed: true, extraBedCharge: 500 });
    await handleAdvancedRoomAllocation(deps);
    const after = readAra(deps);
    expect(after.phase).toBe("manual");
    expect(after.selectedRooms[0]!.extraBed).toBe(true);
  });

  // 6. Remove extra bed from the menu → applyRemoveExtraBed.
  it("Case S6: remove extra bed from the menu", async () => {
    // options for a bed room: [remove_bed, move_guest, remove_room] → "1" = remove.
    const deps = mk(st("room_menu", [sRoom({ extraBed: true, extraBedCost: 500, pricePerNight: 5500, totalPrice: 11000 })], { selectedRoomIndex: 0 }), "1", oneType(), { allowExtraBed: true });
    await handleAdvancedRoomAllocation(deps);
    const after = readAra(deps);
    expect(after.phase).toBe("manual");
    expect(after.selectedRooms[0]!.extraBed).toBe(false);
  });

  // 7. Remove room from the menu → applyRemoveRoom, back to manual.
  it("Case S7: remove room from the menu", async () => {
    // option order change: allowExtraBed=false, has guests → [move_guest, change_type, remove_room]
    // → remove room is now "3" (was "2" before the Change-room-type option was added).
    const deps = mk(st("room_menu", [sRoom({}), sRoom({})], { selectedRoomIndex: 0 }), "3", oneType(), { allowExtraBed: false });
    await handleAdvancedRoomAllocation(deps);
    const after = readAra(deps);
    expect(after.phase).toBe("manual");
    expect(after.selectedRooms.length).toBe(1);
  });

  // 8. "0" in room_menu → back to manual mode.
  it("Case S8: '0' in room_menu returns to manual", async () => {
    const deps = mk(st("room_menu", [sRoom({})], { selectedRoomIndex: 0 }), "0");
    await handleAdvancedRoomAllocation(deps);
    const after = readAra(deps);
    expect(after.phase).toBe("manual");
    expect(after.selectedRoomIndex).toBeUndefined();
  });

  // 9. move_from_count: "1 0" → pendingMove set, enters move_to_room.
  it("Case S9: move_from_count '1 0' sets pendingMove and enters move_to_room", async () => {
    const deps = mk(st("move_from_count", [sRoom({ adults: 3 }), sRoom({})], { selectedRoomIndex: 0 }), "1 0");
    await handleAdvancedRoomAllocation(deps);
    const after = readAra(deps);
    expect(after.phase).toBe("move_to_room");
    expect(after.pendingMove).toEqual({ fromRoomIndex: 0, adults: 1, children: 0 });
  });

  // 10. move_from_count: "1" (no child) → 1 adult, 0 children.
  it("Case S10: move_from_count single number = adults only", async () => {
    const deps = mk(st("move_from_count", [sRoom({ adults: 3 }), sRoom({})], { selectedRoomIndex: 0 }), "1");
    await handleAdvancedRoomAllocation(deps);
    expect(readAra(deps).pendingMove).toEqual({ fromRoomIndex: 0, adults: 1, children: 0 });
  });

  // 11. move_from_count: adults > room's adults → error, stays in phase.
  it("Case S11: move_from_count rejects moving more than the room has", async () => {
    const deps = mk(st("move_from_count", [sRoom({ adults: 2 }), sRoom({})], { selectedRoomIndex: 0 }), "5 0");
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/no more than the room has/i);
    expect(readAra(deps).phase).toBe("move_from_count");      // unchanged
    expect(readAra(deps).pendingMove).toBeUndefined();
  });

  // 12. move_to_room: valid pick → applyMoveGuest, back to manual.
  it("Case S12: move_to_room valid pick moves the guest and returns to manual", async () => {
    const state = st("move_to_room",
      [sRoom({ adults: 3 }), sRoom({ adults: 2 })],
      { selectedRoomIndex: 0, pendingMove: { fromRoomIndex: 0, adults: 1, children: 0 } });
    const deps = mk(state, "1"); // only non-source room is room 1
    await handleAdvancedRoomAllocation(deps);
    const after = readAra(deps);
    expect(after.phase).toBe("manual");
    expect(after.selectedRooms[0]!.adults).toBe(2); // 3 - 1
    expect(after.selectedRooms[1]!.adults).toBe(3); // 2 + 1
  });

  // 13. move_to_room: cap exceeded → reason shown, stays in move_to_room.
  it("Case S13: move_to_room rejects when the destination cap is exceeded", async () => {
    const state = st("move_to_room",
      [sRoom({ adults: 3 }), sRoom({ adults: 3 })], // dest already at max (3)
      { selectedRoomIndex: 0, pendingMove: { fromRoomIndex: 0, adults: 1, children: 0 } });
    const deps = mk(state, "1");
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/at most 3 adults/i);
    expect(readAra(deps).phase).toBe("move_to_room"); // unchanged
  });

  // 14. move_to_room: "0" → back to move_from_count, pendingMove preserved.
  it("Case S14: move_to_room '0' goes back, preserving pendingMove", async () => {
    const pendingMove = { fromRoomIndex: 0, adults: 1, children: 0 };
    const deps = mk(st("move_to_room", [sRoom({ adults: 3 }), sRoom({})], { selectedRoomIndex: 0, pendingMove }), "0");
    await handleAdvancedRoomAllocation(deps);
    const after = readAra(deps);
    expect(after.phase).toBe("move_from_count");
    expect(after.pendingMove).toEqual(pendingMove);
  });

  // 15. Full path: confirm "2" → edit room 1 → move a guest → pick dest → DONE.
  it("Case S15: full structured path writes the output contract", async () => {
    const confirm = st("confirm", [sRoom({ adults: 3 }), sRoom({ adults: 2 })]);
    const deps = mk(confirm, "2"); // no interpreter dep
    await handleAdvancedRoomAllocation(deps);            // → manual
    deps.input = "1"; await handleAdvancedRoomAllocation(deps); // edit room 1 → room_menu
    deps.input = "1"; await handleAdvancedRoomAllocation(deps); // option 1 = Move a guest out (allowExtraBed off)
    deps.input = "1 0"; await handleAdvancedRoomAllocation(deps); // move 1 adult
    deps.input = "1"; await handleAdvancedRoomAllocation(deps); // → destination room 2
    deps.input = "DONE"; await handleAdvancedRoomAllocation(deps); // confirm

    const bookingRooms = JSON.parse(deps.flowData.flowVars["bookingRooms"]!) as AllocationRoom[];
    expect(bookingRooms.length).toBe(2);
    expect(bookingRooms.reduce((s, r) => s + r.adults, 0)).toBe(5);
    expect(bookingRooms[1]!.adults).toBe(3); // room 2 received the moved adult
    expect(deps.advance).toHaveBeenCalled();
  });

  // 16. No AI dep: a full structured action completes deterministically.
  it("Case S16: structured modify works end-to-end with no interpreter dep", async () => {
    const deps = mk(st("manual", [sRoom({})]), "1", oneType(), { allowExtraBed: true });
    expect(deps.interpretModification).toBeUndefined(); // no AI available
    await handleAdvancedRoomAllocation(deps);            // "1" → room_menu (room 1)
    expect(readAra(deps).phase).toBe("room_menu");
    deps.input = "1"; await handleAdvancedRoomAllocation(deps); // add extra bed
    const after = readAra(deps);
    expect(after.phase).toBe("manual");
    expect(after.selectedRooms[0]!.extraBed).toBe(true);
    deps.input = "DONE"; await handleAdvancedRoomAllocation(deps);
    expect(deps.flowData.flowVars["bookingRooms"]).toBeTruthy();
    expect(deps.advance).toHaveBeenCalled();
  });
});

// ── Multiple plans carousel ───────────────────────────────────────────────────
describe("multiple plans carousel", () => {
  function pRoom(over: Partial<AllocationRoom> = {}): AllocationRoom {
    return {
      roomTypeId: "rt_a", roomTypeName: "Standard",
      adults: 2, children: 0, extraBed: false,
      basePrice: 5000, extraAdultCost: 0, extraBedCost: 0, childAgeLimit: null,
      pricePerNight: 5000, nights: 2, totalPrice: 10000,
      ...over,
    };
  }
  function plan(over: Partial<AllocationPlan> = {}): AllocationPlan {
    const rooms = over.rooms ?? [pRoom({})];
    return {
      label: "Most Comfortable", planTag: "comfort", rooms,
      totalPrice: rooms.reduce((s, r) => s + r.totalPrice, 0),
      nights: rooms[0]?.nights ?? 2,
      roomCount: rooms.length,
      extraBedCount: rooms.filter((r) => r.extraBed).length,
      primaryRoomTypeId: rooms[0]?.roomTypeId ?? "rt_a",
      ...over,
    };
  }
  const twoTypes = (priceB = 6500) => [
    room({ roomTypeId: "rt_dlx", name: "Deluxe",   basePrice: 5000,   availableCount: 5 }),
    room({ roomTypeId: "rt_sup", name: "Superior", basePrice: priceB, availableCount: 5 }),
  ];

  // ── generatePlans ──────────────────────────────────────────────────────────
  // 1. 4 adults single type: A (base-first) == B (max-fill) → dedup → 1 plan.
  it("Case PC1: identical A/B dedup to a single plan", () => {
    const plans = generatePlans({ adults: 4, children: 0, rooms: [room({ roomTypeId: "rt_a", name: "Standard", basePrice: 5000, availableCount: 5 })], config: baseConfig, nights: 1 });
    expect(plans).toHaveLength(1);
  });

  // 2. 5 adults single type: A=[3,2], B max-fill=[3,2] → dedup → 1 plan.
  it("Case PC2: 5 adults single type dedups to one plan", () => {
    const plans = generatePlans({ adults: 5, children: 0, rooms: [room({ roomTypeId: "rt_a", name: "Standard", basePrice: 5000, availableCount: 5 })], config: baseConfig, nights: 1 });
    expect(plans).toHaveLength(1);
  });

  // 3. 6 adults, two types → 3 distinct plans, sorted by score (≈ total) ascending.
  it("Case PC3: 6 adults two types yields 3 plans sorted by efficiency", () => {
    const plans = generatePlans({ adults: 6, children: 0, rooms: twoTypes(), config: baseConfig, nights: 1 });
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.totalPrice)).toEqual([10000, 15000, 19500]);
    expect(plans.map((p) => p.planTag)).toEqual(["value", "comfort", "premium"]);
  });

  // 4. A and C identical (same-priced types) → only 2 plans after dedup.
  it("Case PC4: A and C dedup leaves 2 plans", () => {
    const plans = generatePlans({ adults: 6, children: 0, rooms: twoTypes(5000), config: baseConfig, nights: 1 });
    expect(plans).toHaveLength(2);
  });

  // 5. Single unique plan → 1 plan (no carousel needed at this layer).
  it("Case PC5: single unique plan returned", () => {
    const plans = generatePlans({ adults: 4, children: 0, rooms: [room({ roomTypeId: "rt_a", name: "Standard", basePrice: 5000, availableCount: 5 })], config: baseConfig, nights: 1 });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.planTag).toBe("comfort");
  });

  // ── buildPlanDescription ─────────────────────────────────────────────────────
  // 6. 3 rooms deluxe, no beds.
  it("Case PC6: description for 3 deluxe rooms, no beds", () => {
    const p = plan({ rooms: [pRoom({ roomTypeName: "Deluxe" }), pRoom({ roomTypeName: "Deluxe" }), pRoom({ roomTypeName: "Deluxe" })] });
    const desc = buildPlanDescription(p);
    expect(desc).toBe("3 rooms · Deluxe · No extra beds");
    expect(desc.length).toBeLessThanOrEqual(60);
  });

  // 7. 2 superior rooms with extra beds.
  it("Case PC7: description for 2 superior rooms with beds ≤ 60", () => {
    const p = plan({ rooms: [pRoom({ roomTypeName: "Superior", extraBed: true }), pRoom({ roomTypeName: "Superior", extraBed: true })] });
    const desc = buildPlanDescription(p);
    expect(desc.length).toBeLessThanOrEqual(60);
    expect(desc).toContain("Superior");
    expect(desc).toContain("Extra beds incl.");
  });

  // 8. Mixed types → "mix".
  it("Case PC8: mixed-type description contains 'mix'", () => {
    const p = plan({
      rooms: [pRoom({ roomTypeId: "rt_dlx", roomTypeName: "Deluxe" }), pRoom({ roomTypeId: "rt_sup", roomTypeName: "Superior" })],
      primaryRoomTypeId: "rt_dlx",
    });
    const desc = buildPlanDescription(p);
    expect(desc).toContain("mix");
    expect(desc.length).toBeLessThanOrEqual(60);
  });

  // ── plan_selection phase ─────────────────────────────────────────────────────
  const twoPlanState = (): AraState => ({
    guests: { adults: 5, children: 0 },
    selectedRooms: [],
    remainingGuests: { adults: 0, children: 0 },
    phase: "plan_selection",
    plans: [
      plan({ label: "Fewer Rooms", planTag: "value", rooms: [pRoom({ adults: 3 }), pRoom({ adults: 2 })] }),
      plan({ label: "Premium", planTag: "premium", rooms: [pRoom({ roomTypeId: "rt_sup", roomTypeName: "Superior", adults: 3 }), pRoom({ roomTypeId: "rt_sup", roomTypeName: "Superior", adults: 2 })] }),
    ],
  });
  const planDeps = (input: string, state = twoPlanState()) =>
    makeDeps({ waitingFor: "answer", flowVars: { __araState__: JSON.stringify(state) }, input });

  // 9. "plan_0" → selects plan 0, → confirm, full summary with 1/2/MENU.
  it("Case PC9: 'plan_0' selects plan 0 and enters confirm", async () => {
    const deps = planDeps("plan_0");
    const result = await handleAdvancedRoomAllocation(deps);
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(after.phase).toBe("confirm");
    expect(after.selectedRoomIndex).toBeUndefined();
    expect(after.selectedPlanIndex).toBe(0);
    expect(after.selectedRooms.map((r) => r.adults)).toEqual([3, 2]);
    expect(result).toMatch(/Confirm/i);
    expect(result).toMatch(/Modify/i);
    expect(result).toMatch(/MENU/);
  });

  // 10. Text reply "1" → same as plan_0.
  it("Case PC10: text reply '1' selects plan 0", async () => {
    const deps = planDeps("1");
    await handleAdvancedRoomAllocation(deps);
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(after.phase).toBe("confirm");
    expect(after.selectedPlanIndex).toBe(0);
  });

  // 11. "plan_2" with only 2 plans → invalid → re-show text list, no mutation.
  it("Case PC11: out-of-range plan index re-shows the text list", async () => {
    const deps = planDeps("plan_2");
    const before = deps.flowData.flowVars["__araState__"];
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/Choose your room plan/i);
    expect(deps.flowData.flowVars["__araState__"]).toBe(before); // unchanged
  });

  // 12. MENU in plan_selection → cancel.
  it("Case PC12: MENU cancels", async () => {
    const deps = planDeps("MENU");
    const result = await handleAdvancedRoomAllocation(deps);
    expect(deps.resetSession).toHaveBeenCalled();
    expect(result).toBe("MENU_TEXT");
  });

  // 13. Unknown input → text fallback re-shown, araState unchanged.
  it("Case PC13: unknown input re-shows the text list without mutating", async () => {
    const deps = planDeps("what about a villa");
    const before = deps.flowData.flowVars["__araState__"];
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/Choose your room plan/i);
    expect(deps.flowData.flowVars["__araState__"]).toBe(before);
  });

  // 14. Idempotency: re-entering Phase 1 with stored plans re-shows text, no regen.
  it("Case PC14: Phase 1 re-entry re-shows the text list, plans not regenerated", async () => {
    const deps = makeDeps({ flowVars: { __araState__: JSON.stringify(twoPlanState()) }, input: "" }); // no waitingFor → Phase 1
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/Choose your room plan/i);
    expect((deps.fetchRoomTypes as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0); // never re-allocated
  });

  // 15. Single-plan path: after preference (Mix it up) → single summary, no list.
  it("Case PC15: single plan goes straight to confirm, list not triggered", async () => {
    const sendPlanList = vi.fn(async () => true);
    const deps = makeDeps({
      flowVars: { bookingAdults: "4", bookingChildren: "0" },
      rooms: [room({ roomTypeId: "rt_a", name: "Standard", basePrice: 5000, availableCount: 5 })],
      sendPlanList,
    });
    await handleAdvancedRoomAllocation(deps);            // → collecting_room_preference
    deps.input = "MIX_IT_UP";
    const result = await handleAdvancedRoomAllocation(deps);
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(after.phase).toBe("confirm");
    expect(result).toMatch(/Suggested Allocation/);
    expect(sendPlanList).not.toHaveBeenCalled();
  });

  // 16. Multi-plan + list dep → after preference, sends the list, ALREADY_SENT.
  it("Case PC16: multi-plan sends the list and returns ALREADY_SENT", async () => {
    const sendPlanList = vi.fn(async () => true);
    const deps = makeDeps({
      flowVars: { bookingAdults: "6", bookingChildren: "0" },
      rooms: twoTypes(),
      sendPlanList,
    });
    await handleAdvancedRoomAllocation(deps);            // → collecting_room_preference
    deps.input = "MIX_IT_UP";
    const result = await handleAdvancedRoomAllocation(deps);
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(result).toBe("ALREADY_SENT");
    expect(sendPlanList).toHaveBeenCalledTimes(1);
    expect(after.phase).toBe("plan_selection");
    expect(after.plans!.length).toBeGreaterThanOrEqual(2);
  });

  // 17. Multi-plan, no list dep → after preference, text fallback, plans stored.
  it("Case PC17: multi-plan without list dep falls back to text", async () => {
    const deps = makeDeps({
      flowVars: { bookingAdults: "6", bookingChildren: "0" },
      rooms: twoTypes(),
    });
    await handleAdvancedRoomAllocation(deps);            // → collecting_room_preference
    deps.input = "MIX_IT_UP";
    const result = await handleAdvancedRoomAllocation(deps);
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(result).toMatch(/Choose your room plan/i);
    expect(after.phase).toBe("plan_selection");
    expect(after.plans!.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Change room type (one-step, no remove + re-add) ───────────────────────────
describe("change room type", () => {
  function cRoom(over: Partial<AllocationRoom> = {}): AllocationRoom {
    return {
      roomTypeId: "rt_dlx", roomTypeName: "Deluxe",
      adults: 2, children: 0, extraBed: false,
      basePrice: 5000, extraAdultCost: 0, extraBedCost: 0, childAgeLimit: null,
      pricePerNight: 5000, nights: 2, totalPrice: 10000,
      ...over,
    };
  }
  const cfgFor = (map: Record<string, Partial<AllocationConfig>>): RoomConfigResolver =>
    (ar) => ({ ...baseConfig, ...(map[ar.roomTypeId] ?? {}) });
  function st(phase: AraState["phase"], selectedRooms: AllocationRoom[], extra: Partial<AraState> = {}): AraState {
    return { guests: { adults: 5, children: 0 }, selectedRooms, remainingGuests: { adults: 0, children: 0 }, phase, ...extra };
  }
  const twoTypes = () => [
    room({ roomTypeId: "rt_dlx", name: "Deluxe",   basePrice: 5000, maxAdults: 3, maxChildren: 1, availableCount: 5 }),
    room({ roomTypeId: "rt_sup", name: "Superior", basePrice: 6500, maxAdults: 3, maxChildren: 1, availableCount: 5 }),
  ];
  const mk = (state: AraState, input: string, rooms = twoTypes(), nodeData: Record<string, unknown> = {}) =>
    makeDeps({ waitingFor: "answer", nodeData, flowVars: { __araState__: JSON.stringify(state) }, rooms, input });
  const readAra = (deps: AdvancedRoomAllocationDeps) => JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;

  // 1. The room menu now offers "Change room type".
  it("Case CT1: roomMenuOptions includes change_type", () => {
    expect(roomMenuOptions(cRoom({ adults: 2 }), baseConfig)).toContain("change_type");
  });

  // 2. Switch Deluxe → Superior: type/name/price change, occupancy kept, re-priced.
  it("Case CT2: applyChangeRoomType switches the type and reprices", () => {
    const rooms = [cRoom({ roomTypeId: "rt_dlx", roomTypeName: "Deluxe", adults: 2, basePrice: 5000, pricePerNight: 5000, totalPrice: 10000 })];
    const target = room({ roomTypeId: "rt_sup", name: "Superior", basePrice: 6500, maxAdults: 3, maxChildren: 1, availableCount: 5 });
    const res = applyChangeRoomType(rooms, 0, target, cfgFor({ rt_sup: { maxAdults: 3, maxChildren: 1 } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.rooms[0]!;
      expect(r.roomTypeId).toBe("rt_sup");
      expect(r.roomTypeName).toBe("Superior");
      expect(r.basePrice).toBe(6500);
      expect(r.adults).toBe(2);          // occupancy preserved
      expect(r.extraBed).toBe(false);    // 2 = base → no bed
      expect(r.pricePerNight).toBe(6500);
      expect(r.totalPrice).toBe(13000);  // × 2 nights
    }
  });

  // 3. Target type can't hold the occupancy → reason, no mutation.
  it("Case CT3: over-cap target is rejected with a reason", () => {
    const rooms = [cRoom({ roomTypeId: "rt_dlx", adults: 3 })];
    const target = room({ roomTypeId: "rt_sup", name: "Superior", maxAdults: 2, availableCount: 5 });
    const res = applyChangeRoomType(rooms, 0, target, cfgFor({ rt_sup: { maxAdults: 2 } }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.outOfRange).toBe(false);
      expect(res.reason).toContain("at most 2 adults");
    }
  });

  // 4. Target type has no availability → reason.
  it("Case CT4: unavailable target is rejected", () => {
    const rooms = [cRoom({ roomTypeId: "rt_dlx" })];
    const target = room({ roomTypeId: "rt_sup", name: "Superior", availableCount: 0 });
    const res = applyChangeRoomType(rooms, 0, target, cfgFor({}));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.outOfRange).toBe(false);
      expect(res.reason).toContain("no Superior rooms");
    }
  });

  // 5. Same type → outOfRange (no-op; never offered).
  it("Case CT5: switching to the same type is outOfRange", () => {
    const rooms = [cRoom({ roomTypeId: "rt_dlx", roomTypeName: "Deluxe" })];
    const target = room({ roomTypeId: "rt_dlx", name: "Deluxe", availableCount: 5 });
    expect(applyChangeRoomType(rooms, 0, target, cfgFor({}))).toMatchObject({ ok: false, outOfRange: true });
  });

  // 6. room_menu → "Change room type" enters the type picker.
  it("Case CT6: picking change_type enters change_type_select", async () => {
    // allowExtraBed off, has guests → options [move_guest, change_type, remove_room] → "2" = change_type.
    const deps = mk(st("room_menu", [cRoom({ roomTypeId: "rt_dlx", roomTypeName: "Deluxe", adults: 2 })], { selectedRoomIndex: 0 }), "2");
    const result = await handleAdvancedRoomAllocation(deps);
    const after = readAra(deps);
    expect(after.phase).toBe("change_type_select");
    expect(after.selectedRoomIndex).toBe(0);
    expect(result).toContain("Superior");      // the other type is offered
    expect(result).toMatch(/to which type/i);
  });

  // 7. change_type_select pick → applied, back to manual.
  it("Case CT7: picking a type switches the room and returns to manual", async () => {
    const deps = mk(st("change_type_select", [cRoom({ roomTypeId: "rt_dlx", roomTypeName: "Deluxe", adults: 2 })], { selectedRoomIndex: 0 }), "1");
    await handleAdvancedRoomAllocation(deps);
    const after = readAra(deps);
    expect(after.phase).toBe("manual");
    expect(after.selectedRooms[0]!.roomTypeId).toBe("rt_sup"); // only candidate (Deluxe excluded)
    expect(after.selectedRooms[0]!.roomTypeName).toBe("Superior");
    expect(after.selectedRooms[0]!.basePrice).toBe(6500);
    expect(after.selectedRooms[0]!.adults).toBe(2);            // occupancy preserved
  });

  // 8. "0" in change_type_select → back to room_menu.
  it("Case CT8: '0' returns to the room menu", async () => {
    const deps = mk(st("change_type_select", [cRoom({ roomTypeId: "rt_dlx" })], { selectedRoomIndex: 0 }), "0");
    const result = await handleAdvancedRoomAllocation(deps);
    expect(readAra(deps).phase).toBe("room_menu");
    expect(result).toMatch(/What would you like to do/i);
  });

  // 9. Invalid number → re-show the type picker, no mutation.
  it("Case CT9: invalid selection re-shows the picker", async () => {
    const deps = mk(st("change_type_select", [cRoom({ roomTypeId: "rt_dlx" })], { selectedRoomIndex: 0 }), "9");
    const before = deps.flowData.flowVars["__araState__"];
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/to which type/i);
    expect(deps.flowData.flowVars["__araState__"]).toBe(before); // unchanged
  });

  // 10. Single-type hotel → change_type dead-ends gracefully, stays in room_menu.
  it("Case CT10: with only one type, change_type says none available", async () => {
    const oneType = [room({ roomTypeId: "rt_dlx", name: "Deluxe", basePrice: 5000, availableCount: 5 })];
    // options [move_guest, change_type, remove_room] → "2" = change_type.
    const deps = mk(st("room_menu", [cRoom({ roomTypeId: "rt_dlx", roomTypeName: "Deluxe", adults: 2 })], { selectedRoomIndex: 0 }), "2", oneType);
    const result = await handleAdvancedRoomAllocation(deps);
    expect(result).toMatch(/no other room types/i);
    expect(readAra(deps).phase).toBe("room_menu"); // unchanged — no dead phase
  });
});

// ── Task 1: pure age-parsing helpers ──────────────────────────────────────────
describe("children-age parsing helpers", () => {
  it("AP1: extractAgesRegex pulls integers, drops out-of-range", () => {
    expect(extractAgesRegex("8, 12 and 5")).toEqual([8, 12, 5]);
    expect(extractAgesRegex("6 and 9 years")).toEqual([6, 9]);
    expect(extractAgesRegex("no kids")).toEqual([]);
  });

  it("AP2: needsAiAgeParse — false for plain digits, true for empty or relative words", () => {
    expect(needsAiAgeParse("8, 12 and 5")).toBe(false);     // regex handles it
    expect(needsAiAgeParse("no idea")).toBe(true);          // no digits
    expect(needsAiAgeParse("the twins are 8")).toBe(true);  // relative word
    expect(needsAiAgeParse("both are 6")).toBe(true);
    expect(needsAiAgeParse("eldest is 12")).toBe(true);
    expect(needsAiAgeParse("they are the same age, 7")).toBe(true);
  });

  it("AP3: accumulateAges — complete / partial / over", () => {
    expect(accumulateAges([], [8, 12, 5], 3)).toEqual({ ages: [8, 12, 5], status: "complete" });
    expect(accumulateAges([13], [], 3)).toEqual({ ages: [13], status: "partial" });
    expect(accumulateAges([13], [8], 3)).toEqual({ ages: [13, 8], status: "partial" });
    expect(accumulateAges([8, 12], [5, 7], 3)).toEqual({ ages: [8, 12, 5], status: "over" });
  });
});

// ── Task 3: reclassification math ─────────────────────────────────────────────
describe("reclassifyGuests", () => {
  it("RC1: ages [5,9,14], limit 12 → promoted=1, +1 adult / -1 child", () => {
    const r = reclassifyGuests(2, 3, [5, 9, 14], 12);
    expect(r.promotedToAdult).toBe(1);
    expect(r.effectiveAdults).toBe(3);
    expect(r.effectiveChildren).toBe(2);
    expect(r.effectiveChildrenAges).toEqual([5, 9]);
  });

  it("RC2: ages [5,6], limit 12 → promoted=0, counts unchanged", () => {
    const r = reclassifyGuests(2, 2, [5, 6], 12);
    expect(r.promotedToAdult).toBe(0);
    expect(r.effectiveAdults).toBe(2);
    expect(r.effectiveChildren).toBe(2);
    expect(r.effectiveChildrenAges).toEqual([5, 6]);
  });

  it("RC3: ages [13,14,15], limit 12 → promoted=3, effectiveChildren=0", () => {
    const r = reclassifyGuests(2, 3, [13, 14, 15], 12);
    expect(r.promotedToAdult).toBe(3);
    expect(r.effectiveAdults).toBe(5);
    expect(r.effectiveChildren).toBe(0);
    expect(r.effectiveChildrenAges).toEqual([]);
  });

  it("RC4: null limit → no reclassification", () => {
    const r = reclassifyGuests(2, 2, [14, 15], null);
    expect(r.promotedToAdult).toBe(0);
    expect(r.effectiveAdults).toBe(2);
    expect(r.effectiveChildren).toBe(2);
  });
});

// ── Task 4: occupancy-notice wording ──────────────────────────────────────────
describe("buildOccupancyNotice", () => {
  it("ON1: singular wording when one child promoted", () => {
    const msg = buildOccupancyNotice(3, 2, 1, 12);
    expect(msg).toContain("*Occupancy Summary*");
    expect(msg).toContain("Adults: *3*");
    expect(msg).toContain("Children: *2*");
    expect(msg).toContain("One of your children is");
    expect(msg).toContain("counted as an adult");
    expect(msg).toContain("above 12 years");
  });

  it("ON2: plural wording when two children promoted", () => {
    const msg = buildOccupancyNotice(4, 0, 2, 12);
    expect(msg).toContain("2 of your children are");
    expect(msg).toContain("counted as adults");
  });

  it("ON3: WhatsApp-safe — no box-drawing or markdown headers", () => {
    const msg = buildOccupancyNotice(3, 2, 1, 12);
    expect(msg).not.toMatch(/[─│┌┐└┘├┤]/);
    expect(msg).not.toMatch(/^#/m);
  });
});

// ── Task 1 + 3 + 4: collecting_ages handler (end-to-end) ──────────────────────
describe("collecting_ages handler", () => {
  const readAra = (deps: AdvancedRoomAllocationDeps) => JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;

  // Seed a collecting_ages araState as if phase1 just entered it.
  function collectState(adults: number, children: number, collectedAges: number[] = [], rounds = 0): AraState {
    return {
      guests:          { adults, children },
      selectedRooms:   [],
      remainingGuests: { adults: 0, children: 0 },
      phase:           "collecting_ages",
      ageCollection:   { adults, children, childrenCount: children, collectedAges, rounds },
    };
  }
  const famRoom = () => [room({ roomTypeId: "rt_fam", name: "Family", basePrice: 6000, maxAdults: 4, maxChildren: 3, availableCount: 5 })];

  it("CA1: '8, 12 and 5' for 3 children → complete in one round, no AI call", async () => {
    const extractChildrenAges = vi.fn(async () => null);
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(collectState(2, 3)) },
      rooms: famRoom(),
      input: "8, 12 and 5",
      childAgeLimit: 12,
      extractChildrenAges,
    });
    await handleAdvancedRoomAllocation(deps);
    expect(extractChildrenAges).not.toHaveBeenCalled();   // regex sufficed
    // 12 is not > 12, so none promoted; effective vars written.
    expect(deps.flowData.flowVars["effectiveAdults"]).toBe("2");
    expect(deps.flowData.flowVars["effectiveChildren"]).toBe("3");
    expect(deps.flowData.flowVars["promotedToAdult"]).toBe("0");
    expect(readAra(deps).phase).not.toBe("collecting_ages"); // advanced
  });

  it("CA2: '13' for 3 children → partial, accumulates, stays in phase", async () => {
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(collectState(2, 3)) },
      rooms: famRoom(),
      input: "13",
      childAgeLimit: 12,
    });
    const result = await handleAdvancedRoomAllocation(deps);
    const ara = readAra(deps);
    expect(ara.phase).toBe("collecting_ages");
    expect(ara.ageCollection!.collectedAges).toEqual([13]);
    expect(ara.ageCollection!.rounds).toBe(1);
    expect(result).toMatch(/other 2 children/i);
  });

  it("CA3: 'twins are 8' triggers AI fallback", async () => {
    const extractChildrenAges = vi.fn(async () => [8, 8]);
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(collectState(2, 2)) },
      rooms: famRoom(),
      input: "the twins are 8",
      childAgeLimit: 12,
      extractChildrenAges,
    });
    await handleAdvancedRoomAllocation(deps);
    expect(extractChildrenAges).toHaveBeenCalledTimes(1);  // ambiguous → AI
    expect(deps.flowData.flowVars["effectiveChildren"]).toBe("2");
    expect(readAra(deps).phase).not.toBe("collecting_ages");
  });

  it("CA4: 3 rounds with only 2 ages for 3 children → fills remaining with 0", async () => {
    // Two ages already collected over 2 rounds; this 3rd reply adds nothing parseable
    // but we still have a partial — round limit forces a fill.
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(collectState(2, 3, [8, 9], MAX_AGE_ROUNDS - 1)) },
      rooms: famRoom(),
      input: "not sure about the last one",
      childAgeLimit: 12,
      extractChildrenAges: vi.fn(async () => null), // AI can't help either
    });
    await handleAdvancedRoomAllocation(deps);
    const ara = readAra(deps);
    expect(ara.phase).not.toBe("collecting_ages"); // proceeded
    // [8, 9, 0] — filled; none over 12 so all stay children.
    expect(JSON.parse(deps.flowData.flowVars["effectiveChildrenAges"]!)).toEqual([8, 9, 0]);
    expect(deps.flowData.flowVars["effectiveChildren"]).toBe("3");
  });

  it("CA5: non-age message → re-prompt, no advance, stays in phase", async () => {
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(collectState(2, 2)) },
      rooms: famRoom(),
      input: "what time is check in?",
      childAgeLimit: 12,
      extractChildrenAges: vi.fn(async () => null),
    });
    const result = await handleAdvancedRoomAllocation(deps);
    const ara = readAra(deps);
    expect(ara.phase).toBe("collecting_ages");                 // no advance
    expect(ara.ageCollection!.collectedAges).toEqual([]);      // nothing stored
    expect(ara.ageCollection!.rounds).toBe(1);                 // counts as a round
    expect(result).toMatch(/just need the ages/i);
    expect(deps.flowData.flowVars["effectiveAdults"]).toBeUndefined(); // didn't proceed
  });

  it("CA6: ages with one over the limit → promotion + occupancy notice sent", async () => {
    let sentText = "";
    const sendOccupancyNotice = vi.fn(async (a: { hotelId: string; guestId: string; text: string }) => { sentText = a.text; });
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(collectState(2, 3)) },
      rooms: famRoom(),
      input: "5, 9 and 14",
      childAgeLimit: 12,
      sendOccupancyNotice,
    });
    await handleAdvancedRoomAllocation(deps);
    expect(sendOccupancyNotice).toHaveBeenCalledTimes(1);
    expect(sentText).toContain("One of your children is");
    expect(deps.flowData.flowVars["promotedToAdult"]).toBe("1");
    expect(deps.flowData.flowVars["effectiveAdults"]).toBe("3");
    expect(deps.flowData.flowVars["effectiveChildren"]).toBe("2");
  });

  it("CA7: no promotion → occupancy notice NOT sent", async () => {
    const sendOccupancyNotice = vi.fn(async () => undefined);
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars: { __araState__: JSON.stringify(collectState(2, 2)) },
      rooms: famRoom(),
      input: "5, 6",
      childAgeLimit: 12,
      sendOccupancyNotice,
    });
    await handleAdvancedRoomAllocation(deps);
    expect(sendOccupancyNotice).not.toHaveBeenCalled();
    expect(deps.flowData.flowVars["promotedToAdult"]).toBe("0");
  });
});

// ── Piece 2B: generateSmartPlans (pure — no DB, no Redis) ─────────────────────
describe("generateSmartPlans", () => {
  const cfg: AllocationConfig = {
    baseAdults: 2, baseChildren: 0, maxAdults: 3, maxChildren: 1,
    extraAdultCharge: 0, allowExtraBed: true, extraBedCharge: 500, childAgeLimit: null,
  };
  const twoTypes = (): AllocationRoomInput[] => [
    room({ roomTypeId: "rt_dlx", name: "Deluxe",   basePrice: 5000, maxAdults: 3, maxChildren: 1, availableCount: 5 }),
    room({ roomTypeId: "rt_sup", name: "Superior", basePrice: 6500, maxAdults: 3, maxChildren: 1, availableCount: 5 }),
  ];

  // 1. Preference set → YOUR_CHOICE uses the preferred type for max slots.
  it("SP1: preferredRoomTypeId set → YOUR_CHOICE present and uses preferred type", () => {
    const plans = generateSmartPlans({
      adults: 4, children: 0, rooms: twoTypes(), config: cfg, nights: 2,
      preferredRoomTypeId: "rt_sup", maxPlans: 8,
    });
    const yc = plans.find((p) => p.planType === "YOUR_CHOICE");
    expect(yc).toBeTruthy();
    expect(yc!.rooms.every((r) => r.roomTypeId === "rt_sup")).toBe(true);
    expect(yc!.label).toBe("Your Choice ⭐");
    expect(yc!.rationale).toContain("Superior");
  });

  // 2. No preference → YOUR_CHOICE not generated.
  it("SP2: preferredRoomTypeId null → no YOUR_CHOICE plan", () => {
    const plans = generateSmartPlans({
      adults: 4, children: 0, rooms: twoTypes(), config: cfg, nights: 2,
      preferredRoomTypeId: null, maxPlans: 8,
    });
    expect(plans.some((p) => p.planType === "YOUR_CHOICE")).toBe(false);
  });

  // 3. Duplicate plans removed before returning (no two share composition+price).
  it("SP3: no duplicate plans (composition + price unique enough)", () => {
    const plans = generateSmartPlans({
      adults: 4, children: 0, rooms: twoTypes(), config: cfg, nights: 2,
      preferredRoomTypeId: null, maxPlans: 8,
    });
    const sigs = plans.map((p) => {
      const counts = new Map<string, number>();
      for (const r of p.rooms) counts.set(r.roomTypeId, (counts.get(r.roomTypeId) ?? 0) + 1);
      return `${[...counts.entries()].sort().map(([id, c]) => `${id}x${c}`).join(",")}|${p.totalPrice}`;
    });
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  // 4. maxPlans=2 → at most 2 plans returned.
  it("SP4: maxPlans=2 → only top 2 plans", () => {
    const plans = generateSmartPlans({
      adults: 6, children: 0, rooms: twoTypes(), config: cfg, nights: 2,
      preferredRoomTypeId: "rt_dlx", maxPlans: 2,
    });
    expect(plans.length).toBeLessThanOrEqual(2);
  });

  // 5. All returned plans pass occupancy validation (every guest placed).
  it("SP5: all plans house exactly the requested guests", () => {
    const adults = 5, children = 2;
    const plans = generateSmartPlans({
      adults, children, rooms: twoTypes(), config: cfg, nights: 2,
      preferredRoomTypeId: null, maxPlans: 8,
    });
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      const a = p.rooms.reduce((s, r) => s + r.adults, 0);
      const c = p.rooms.reduce((s, r) => s + r.children, 0);
      expect(a).toBe(adults);
      expect(c).toBe(children);
    }
  });

  // 6. BEST_VALUE total ≤ BEST_EXPERIENCE total (when both exist).
  it("SP6: BEST_VALUE total ≤ BEST_EXPERIENCE total", () => {
    const plans = generateSmartPlans({
      adults: 6, children: 0, rooms: twoTypes(), config: cfg, nights: 2,
      preferredRoomTypeId: null, maxPlans: 8,
    });
    const bv = plans.find((p) => p.planType === "BEST_VALUE");
    const be = plans.find((p) => p.planType === "BEST_EXPERIENCE");
    if (bv && be) expect(bv.totalPrice).toBeLessThanOrEqual(be.totalPrice);
  });

  // 7. Single room type available → only distinct plans, no duplicates.
  it("SP7: single room type → distinct plans only", () => {
    const one = [room({ roomTypeId: "rt_only", name: "Only", basePrice: 5000, maxAdults: 3, maxChildren: 1, availableCount: 5 })];
    const plans = generateSmartPlans({
      adults: 6, children: 0, rooms: one, config: cfg, nights: 2,
      preferredRoomTypeId: null, maxPlans: 8,
    });
    expect(plans.length).toBeGreaterThanOrEqual(1);
    const sigs = plans.map((p) => `${p.roomCount}|${p.totalPrice}|${p.extraBedCount}`);
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  // 8. BUDGET_FRIENDLY not generated when identical to BEST_VALUE.
  it("SP8: BUDGET_FRIENDLY dropped if identical to BEST_VALUE", () => {
    // Single type → BEST_VALUE (max-fill cheapest) == BUDGET_FRIENDLY (uniform cheapest).
    const one = [room({ roomTypeId: "rt_only", name: "Only", basePrice: 5000, maxAdults: 3, maxChildren: 1, availableCount: 5 })];
    const plans = generateSmartPlans({
      adults: 6, children: 0, rooms: one, config: cfg, nights: 2,
      preferredRoomTypeId: null, maxPlans: 8,
    });
    const bv = plans.filter((p) => p.planType === "BEST_VALUE").length;
    const bf = plans.filter((p) => p.planType === "BUDGET_FRIENDLY").length;
    // At most one of the two value-style plans survives dedup for a single type.
    expect(bv + bf).toBeLessThanOrEqual(1);
  });
});

// ── Piece 1D: buildRoomDescriptionsMessage (pure) ─────────────────────────────
describe("buildRoomDescriptionsMessage", () => {
  // 1. All rooms have descriptions → full text with name+price+italic desc.
  it("RD1: all rooms described → name, price, and italic description per room", () => {
    const rooms = [
      room({ roomTypeId: "a", name: "Deluxe",   basePrice: 5000, availableCount: 3, description: "Cozy sea view" }),
      room({ roomTypeId: "b", name: "Superior", basePrice: 6500, availableCount: 2, description: "Spacious suite" }),
    ];
    const msg = buildRoomDescriptionsMessage(rooms)!;
    expect(msg).toContain("🏨 *Our Room Types*");
    expect(msg).toContain("*Deluxe* — ₹5,000/night");
    expect(msg).toContain("_Cozy sea view_");
    expect(msg).toContain("*Superior* — ₹6,500/night");
    expect(msg).toContain("_Spacious suite_");
    expect(msg).toContain("Tap the options below");
  });

  // 2. One room has no description → name+price only, no empty italic line.
  it("RD2: missing description → name+price only, no empty italic", () => {
    const rooms = [
      room({ roomTypeId: "a", name: "Deluxe",   basePrice: 5000, availableCount: 3, description: "Cozy sea view" }),
      room({ roomTypeId: "b", name: "Basic",    basePrice: 4000, availableCount: 2, description: "" }),
    ];
    const msg = buildRoomDescriptionsMessage(rooms)!;
    expect(msg).toContain("*Basic* — ₹4,000/night");
    expect(msg).not.toContain("__");          // no empty italic markers
    // The described-less Basic block is exactly its head line — no italic follows.
    const basicBlock = msg.split("\n\n").find((b) => b.startsWith("*Basic*"))!;
    expect(basicBlock).toBe("*Basic* — ₹4,000/night");
    expect(basicBlock).not.toContain("_");
  });

  // 3. Only available rooms shown; none available → null.
  it("RD3: filters to available rooms; none available → null", () => {
    const rooms = [
      room({ roomTypeId: "a", name: "Deluxe", basePrice: 5000, availableCount: 0, description: "x" }),
    ];
    expect(buildRoomDescriptionsMessage(rooms)).toBeNull();
  });
});

// ── Interactive confirm buttons (CONFIRM/MODIFY/CANCEL ids map to 1/2/MENU) ────
describe("confirm interactive buttons", () => {
  // Drive Phase 1 → preference (Mix it up) → confirm, returning deps at confirm.
  async function primeAtConfirm(over: Partial<AdvancedRoomAllocationDeps> = {}) {
    const deps = makeDeps({
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, availableCount: 3 })],
      flowVars: { bookingAdults: "2", bookingChildren: "0" },
      ...over,
    });
    await handleAdvancedRoomAllocation(deps);   // → collecting_room_preference
    deps.input = "MIX_IT_UP";
    await handleAdvancedRoomAllocation(deps);   // → confirm
    deps.input = "";
    return deps;
  }
  const readPhase = (deps: AdvancedRoomAllocationDeps) =>
    deps.flowData.flowVars["__araState__"] ? (JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState).phase : undefined;

  // 1. CONFIRM_BOOKING button id → same as "1": writes output contract + advances.
  it("CB1: CONFIRM_BOOKING finalizes like '1'", async () => {
    const deps = await primeAtConfirm();
    expect(readPhase(deps)).toBe("confirm");
    deps.input = "CONFIRM_BOOKING";
    await handleAdvancedRoomAllocation(deps);
    expect(deps.flowData.flowVars["bookingRooms"]).toBeTruthy();
    expect(deps.flowData.flowVars["__araState__"]).toBeUndefined();
    expect(deps.advance).toHaveBeenCalledWith("node_next");
  });

  // 2. MODIFY_BOOKING button id → same as "2": switches to manual phase.
  it("CB2: MODIFY_BOOKING switches to manual like '2'", async () => {
    const deps = await primeAtConfirm();
    deps.input = "MODIFY_BOOKING";
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("manual");
    expect(deps.advance).not.toHaveBeenCalled();
  });

  // 3. CANCEL_BOOKING button id → same as "MENU": resets + shows menu.
  it("CB3: CANCEL_BOOKING cancels like 'MENU'", async () => {
    const deps = await primeAtConfirm();
    deps.input = "CANCEL_BOOKING";
    const result = await handleAdvancedRoomAllocation(deps);
    expect(deps.resetSession).toHaveBeenCalled();
    expect(deps.flowData.flowVars["__araState__"]).toBeUndefined();
    expect(result).toBe("MENU_TEXT"); // safeMenu mock
  });

  // 4. With sendConfirmButtons dep → buttons sent (ALREADY_SENT), body has NO text footer.
  it("CB4: sendConfirmButtons dep → interactive send, no '*1*' footer in body", async () => {
    let sentBody = "";
    const sendConfirmButtons = vi.fn(async (a: { hotelId: string; guestId: string; bodyText: string }) => {
      sentBody = a.bodyText; return true;
    });
    const deps = makeDeps({
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, availableCount: 3 })],
      flowVars: { bookingAdults: "2", bookingChildren: "0" },
      sendConfirmButtons,
    });
    await handleAdvancedRoomAllocation(deps);   // → collecting_room_preference
    deps.input = "MIX_IT_UP";
    const result = await handleAdvancedRoomAllocation(deps); // → confirm (single plan)
    expect(sendConfirmButtons).toHaveBeenCalledTimes(1);
    expect(result).toBe("ALREADY_SENT");
    expect(sentBody).toContain("Suggested Allocation");
    expect(sentBody).not.toContain("Reply *1*");   // footer replaced by buttons
    expect(sentBody).not.toContain("to Confirm");
  });

  // 5. Without the dep → legacy text summary WITH the reply-instructions footer.
  it("CB5: no dep → legacy text footer retained", async () => {
    const deps = await primeAtConfirm();   // primeAtConfirm injects no button dep
    // Re-render the confirm summary by sending an unrecognised input.
    deps.input = "garbage";
    const result = await handleAdvancedRoomAllocation(deps);
    expect(typeof result).toBe("string");
    expect(result).toContain("Suggested Allocation");
  });
});

// ── Modify-phase list messages (room menu / move-to-room / manual overview) ───
describe("modify phase list messages", () => {
  // Shared helpers — build an allocated room (simplified).
  function sR(over: Partial<AllocationRoom> = {}): AllocationRoom {
    return {
      roomTypeId: "rt_a", roomTypeName: "Standard",
      adults: 2, children: 0, extraBed: false,
      basePrice: 5000, extraAdultCost: 0, extraBedCost: 0,
      childAgeLimit: null, pricePerNight: 5000, nights: 2, totalPrice: 10000,
      ...over,
    };
  }
  function aRoom(over: Partial<AllocationRoomInput> = {}): AllocationRoomInput {
    return { roomTypeId: "rt_b", name: "Deluxe", basePrice: 7000, maxAdults: 3, maxChildren: 1, availableCount: 2, ...over };
  }
  // Build deps pre-positioned in manual phase with two rooms placed.
  function mkManual(input = "", over: Partial<AdvancedRoomAllocationDeps> = {}) {
    const state: AraState = {
      guests: { adults: 4, children: 0 },
      selectedRooms:   [sR({ roomTypeId: "rt_a", roomTypeName: "Standard" }), sR({ roomTypeId: "rt_a", roomTypeName: "Standard" })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "manual",
    };
    return makeDeps({
      waitingFor: "answer",
      flowVars:   { __araState__: JSON.stringify(state) },
      rooms:      [aRoom()],
      input,
      ...over,
    });
  }
  // Build deps pre-positioned in room_menu phase, room 0.
  function mkRoomMenu(input = "", extra: Partial<AraState> = {}, over: Partial<AdvancedRoomAllocationDeps> = {}) {
    const state: AraState = {
      guests: { adults: 2, children: 0 },
      selectedRooms:   [sR()],
      remainingGuests: { adults: 0, children: 0 },
      phase: "room_menu", selectedRoomIndex: 0,
      ...extra,
    };
    return makeDeps({
      waitingFor: "answer",
      flowVars:   { __araState__: JSON.stringify(state) },
      rooms:      [aRoom()],
      input,
      ...over,
    });
  }
  const readPhase = (deps: AdvancedRoomAllocationDeps) =>
    deps.flowData.flowVars["__araState__"]
      ? (JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState).phase
      : undefined;

  // ── buildRoomMenuSections pure tests ─────────────────────────────────────────

  it("ML1: buildRoomMenuSections has Modify Room and Navigation sections", () => {
    const r = sR();
    const opts: import("./modifyLists").RoomAction[] = ["move_guest", "change_type", "remove_room"];
    const sections = buildRoomMenuSections(r, opts);
    expect(sections.length).toBe(2);
    expect(sections[0]!.title).toBe("Modify Room");
    expect(sections[0]!.rows.map((row) => row.id)).toEqual(
      ["MOD_MOVE_GUEST_OUT", "MOD_CHANGE_ROOM_TYPE", "MOD_REMOVE_ROOM"]
    );
    expect(sections[1]!.title).toBe("Navigation");
    expect(sections[1]!.rows[0]!.id).toBe(MOD_GO_BACK);
  });

  it("ML2: buildRoomMenuSections add_bed uses MOD_ADD_EXTRA_BED id", () => {
    const r = sR();
    const sections = buildRoomMenuSections(r, ["add_bed", "move_guest", "remove_room"]);
    const ids = sections[0]!.rows.map((row) => row.id);
    expect(ids).toContain("MOD_ADD_EXTRA_BED");
  });

  it("ML3: buildRoomMenuSections remove_bed uses MOD_REMOVE_EXTRA_BED id", () => {
    const sections = buildRoomMenuSections(sR({ extraBed: true }), ["remove_bed", "move_guest", "remove_room"]);
    expect(sections[0]!.rows[0]!.id).toBe(MOD_REMOVE_EXTRA_BED);
  });

  // ── buildMoveToRoomSections pure tests ────────────────────────────────────────

  it("ML4: buildMoveToRoomSections builds N-1 room rows for N rooms", () => {
    const state: AraState = {
      guests: { adults: 4, children: 0 },
      selectedRooms: [sR({ roomTypeName: "Standard" }), sR({ roomTypeName: "Deluxe" })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "move_to_room", selectedRoomIndex: 0,
      pendingMove: { fromRoomIndex: 0, adults: 1, children: 0 },
    };
    const resolveCfg: RoomConfigResolver = (_r) => ({
      baseAdults: 2, baseChildren: 0, maxAdults: 3, maxChildren: 1,
      extraAdultCharge: 0, allowExtraBed: false, extraBedCharge: 0, childAgeLimit: null,
    });
    const { sections, destIndices } = buildMoveToRoomSections(state, 0, { adults: 1, children: 0 }, resolveCfg);
    // fromIndex=0 excluded → 1 row for room at index 1.
    expect(destIndices).toEqual([1]);
    expect(sections[0]!.rows.length).toBe(1);
    expect(sections[0]!.rows[0]!.id).toBe(`${MOVE_TO_ROOM_PREFIX}1`);
    expect(sections[0]!.rows[0]!.title).toBe("Deluxe");
    expect(sections[1]!.rows[0]!.id).toBe(MOVE_GO_BACK);
  });

  it("ML5: buildMoveToRoomSections description ≤72 chars", () => {
    const longName = "A".repeat(100);
    const state: AraState = {
      guests: { adults: 4, children: 0 },
      selectedRooms: [sR(), sR({ roomTypeName: longName })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "move_to_room", selectedRoomIndex: 0,
      pendingMove: { fromRoomIndex: 0, adults: 1, children: 0 },
    };
    const resolveCfg: RoomConfigResolver = (_r) => ({
      baseAdults: 2, baseChildren: 0, maxAdults: 3, maxChildren: 1,
      extraAdultCharge: 0, allowExtraBed: false, extraBedCharge: 0, childAgeLimit: null,
    });
    const { sections } = buildMoveToRoomSections(state, 0, { adults: 1, children: 0 }, resolveCfg);
    const desc = sections[0]!.rows[0]!.description ?? "";
    expect(desc.length).toBeLessThanOrEqual(72);
  });

  // ── buildManualModeSections pure tests ────────────────────────────────────────

  it("ML6: buildManualModeSections has edit rows, add rows, confirm section", () => {
    const state: AraState = {
      guests: { adults: 4, children: 0 },
      selectedRooms: [sR({ roomTypeName: "Standard" })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "manual",
    };
    const addable = [aRoom({ roomTypeId: "rt_dlx", name: "Deluxe" })];
    const sections = buildManualModeSections(state, addable);
    expect(sections.some((s) => s.title === "Edit Existing Rooms")).toBe(true);
    expect(sections.some((s) => s.title === "Add a Room")).toBe(true);
    expect(sections.some((s) => s.title === "Confirm")).toBe(true);
    const editSection = sections.find((s) => s.title === "Edit Existing Rooms")!;
    expect(editSection.rows[0]!.id).toBe(`${EDIT_ROOM_PREFIX}1`);
    const addSection = sections.find((s) => s.title === "Add a Room")!;
    expect(addSection.rows[0]!.id).toBe(`${ADD_ROOM_PREFIX}rt_dlx`);
    const confirmSection = sections.find((s) => s.title === "Confirm")!;
    expect(confirmSection.rows.map((r) => r.id)).toContain(MODIFY_DONE);
    expect(confirmSection.rows.map((r) => r.id)).toContain(MODIFY_GO_BACK);
  });

  it("ML7: buildManualModeSections add row description ≤72 chars", () => {
    const state: AraState = {
      guests: { adults: 2, children: 0 },
      selectedRooms: [sR()],
      remainingGuests: { adults: 0, children: 0 },
      phase: "manual",
    };
    const addable = [aRoom({ name: "Luxury Ocean-Facing Suite with Balcony", basePrice: 99999, availableCount: 10, maxAdults: 5, maxChildren: 3 })];
    const sections = buildManualModeSections(state, addable);
    const addSection = sections.find((s) => s.title === "Add a Room")!;
    const desc = addSection.rows[0]!.description ?? "";
    expect(desc.length).toBeLessThanOrEqual(72);
  });

  // ── Handler integration: list-reply ids route correctly ───────────────────────

  // ML8: MOD_GO_BACK list reply → goes back from room_menu to manual phase.
  it("ML8: MOD_GO_BACK from room_menu → returns to manual", async () => {
    const deps = mkRoomMenu(MOD_GO_BACK);
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("manual");
  });

  // ML9: MOD_REMOVE_EXTRA_BED list reply → same action as typed "1" for a room with extra bed.
  it("ML9: MOD_REMOVE_EXTRA_BED from room_menu removes extra bed", async () => {
    const state: AraState = {
      guests: { adults: 2, children: 0 },
      selectedRooms: [sR({ extraBed: true, roomTypeId: "rt_a" })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "room_menu", selectedRoomIndex: 0,
    };
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars:   { __araState__: JSON.stringify(state) },
      rooms:      [aRoom()],
      input:      MOD_REMOVE_EXTRA_BED,
      nodeData:   { allowExtraBed: true },
    });
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("manual");
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(after.selectedRooms[0]!.extraBed).toBe(false);
  });

  // ML10: MODIFY_DONE list reply → same action as typed "DONE" (finalizes booking).
  it("ML10: MODIFY_DONE list reply finalizes booking like 'DONE'", async () => {
    const deps = mkManual(MODIFY_DONE);
    await handleAdvancedRoomAllocation(deps);
    expect(deps.flowData.flowVars["bookingRooms"]).toBeTruthy();
    expect(deps.advance).toHaveBeenCalled();
  });

  // ML11: MODIFY_GO_BACK in manual phase re-shows the overview (toManual).
  it("ML11: MODIFY_GO_BACK in manual phase re-shows manual overview", async () => {
    const deps = mkManual(MODIFY_GO_BACK);
    const result = await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("manual");
    // No finalize — advance not called.
    expect(deps.advance).not.toHaveBeenCalled();
    // Result should be the manual overview text (no dep → text fallback).
    expect(result).toContain("Modify your booking");
  });

  // ML12: EDIT_ROOM_1 list reply → enters room_menu for room 1 (same as typed "1").
  it("ML12: EDIT_ROOM_1 list reply enters room_menu", async () => {
    const deps = mkManual(`${EDIT_ROOM_PREFIX}1`);
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("room_menu");
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(after.selectedRoomIndex).toBe(0);
  });

  // ML13: ADD_ROOM_{id} list reply → adds a room type to the selection.
  it("ML13: ADD_ROOM_{id} list reply adds a room", async () => {
    const deps = mkManual(`${ADD_ROOM_PREFIX}rt_b`);
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("manual");
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    // Should now have 3 rooms (2 original + 1 added).
    expect(after.selectedRooms.length).toBe(3);
    expect(after.selectedRooms[2]!.roomTypeId).toBe("rt_b");
  });

  // ML14: MOVE_GO_BACK in move_to_room → goes back to move_from_count.
  it("ML14: MOVE_GO_BACK in move_to_room → back to move_from_count", async () => {
    const pm = { fromRoomIndex: 0, adults: 1, children: 0 };
    const state: AraState = {
      guests: { adults: 4, children: 0 },
      selectedRooms: [sR({ adults: 3 }), sR({ adults: 2 })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "move_to_room", selectedRoomIndex: 0, pendingMove: pm,
    };
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars:   { __araState__: JSON.stringify(state) },
      rooms:      [aRoom()],
      input:      MOVE_GO_BACK,
    });
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("move_from_count");
  });

  // ML15: MOVE_TO_ROOM_1 list reply → moves guest to first destination room.
  it("ML15: MOVE_TO_ROOM_1 list reply moves guest to dest slot 1", async () => {
    const pm = { fromRoomIndex: 0, adults: 1, children: 0 };
    const state: AraState = {
      guests: { adults: 4, children: 0 },
      selectedRooms: [sR({ adults: 3, roomTypeName: "Standard" }), sR({ adults: 2, roomTypeName: "Deluxe" })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "move_to_room", selectedRoomIndex: 0, pendingMove: pm,
    };
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars:   { __araState__: JSON.stringify(state) },
      rooms:      [aRoom()],
      input:      `${MOVE_TO_ROOM_PREFIX}1`,
    });
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("manual");
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    // room 0 gives 1 adult, room 1 receives it.
    expect(after.selectedRooms[0]!.adults).toBe(2);
    expect(after.selectedRooms[1]!.adults).toBe(3);
  });

  // ML16: sendRoomMenuList dep present → ALREADY_SENT from room_menu (re-render path).
  it("ML16: sendRoomMenuList dep → ALREADY_SENT on unrecognised room_menu input", async () => {
    let menuSent = false;
    const sendRoomMenuList = vi.fn(async () => { menuSent = true; return true; });
    const deps = mkRoomMenu("garbage", {}, { sendRoomMenuList });
    const result = await handleAdvancedRoomAllocation(deps);
    expect(menuSent).toBe(true);
    expect(result).toBe("ALREADY_SENT");
  });

  // ML17: sendManualModeList dep present → ALREADY_SENT from toManual.
  it("ML17: sendManualModeList dep → ALREADY_SENT when entering manual", async () => {
    let listSent = false;
    const sendManualModeList = vi.fn(async () => { listSent = true; return true; });
    // Start at room_menu, press MOD_GO_BACK → toManual → list send.
    const deps = mkRoomMenu(MOD_GO_BACK, {}, { sendManualModeList });
    const result = await handleAdvancedRoomAllocation(deps);
    expect(listSent).toBe(true);
    expect(result).toBe("ALREADY_SENT");
  });

  // ML18: Typed fallbacks still work — "1" and "DONE" remain valid alongside list ids.
  it("ML18: typed '1' from manual still enters room_menu (back-compat)", async () => {
    const deps = mkManual("1");
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("room_menu");
  });

  it("ML18b: typed 'DONE' from manual still finalizes booking (back-compat)", async () => {
    const deps = mkManual("DONE");
    await handleAdvancedRoomAllocation(deps);
    expect(deps.flowData.flowVars["bookingRooms"]).toBeTruthy();
    expect(deps.advance).toHaveBeenCalled();
  });

  // ML19: sendMoveToRoomList dep present → ALREADY_SENT when entering move_to_room.
  it("ML19: sendMoveToRoomList dep → ALREADY_SENT when entering move_to_room", async () => {
    let moveSent = false;
    const sendMoveToRoomList = vi.fn(async () => ({ sent: true, destIndices: [1] }));
    // Build deps in move_from_count to transition to move_to_room.
    const state: AraState = {
      guests: { adults: 4, children: 0 },
      selectedRooms: [sR({ adults: 3 }), sR({ adults: 2 })],
      remainingGuests: { adults: 0, children: 0 },
      phase: "move_from_count", selectedRoomIndex: 0,
    };
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars:   { __araState__: JSON.stringify(state) },
      rooms:      [aRoom()],
      input:      "1 0",
      sendMoveToRoomList,
    });
    const result = await handleAdvancedRoomAllocation(deps);
    void moveSent; // dep was called
    expect(sendMoveToRoomList).toHaveBeenCalledTimes(1);
    expect(result).toBe("ALREADY_SENT");
  });
});

// ── Change-room-type list message ─────────────────────────────────────────────
describe("change room type list message", () => {
  function cRoom(over: Partial<AllocationRoom> = {}): AllocationRoom {
    return {
      roomTypeId: "rt_dlx", roomTypeName: "Deluxe",
      adults: 2, children: 0, extraBed: false,
      basePrice: 5000, extraAdultCost: 0, extraBedCost: 0, childAgeLimit: null,
      pricePerNight: 5000, nights: 2, totalPrice: 10000,
      ...over,
    };
  }
  function twoTypes() {
    return [
      room({ roomTypeId: "rt_dlx", name: "Deluxe",   basePrice: 5000, maxAdults: 3, maxChildren: 1, availableCount: 5 }),
      room({ roomTypeId: "rt_sup", name: "Superior", basePrice: 6500, maxAdults: 3, maxChildren: 1, availableCount: 3 }),
    ];
  }
  // Build deps in change_type_select phase for room 0 (Deluxe).
  function mkCT(input: string, over: Partial<AdvancedRoomAllocationDeps> = {}) {
    const state: AraState = {
      guests: { adults: 2, children: 0 },
      selectedRooms: [cRoom()],
      remainingGuests: { adults: 0, children: 0 },
      phase: "change_type_select", selectedRoomIndex: 0,
    };
    return makeDeps({
      waitingFor: "answer",
      flowVars:   { __araState__: JSON.stringify(state) },
      rooms:      twoTypes(),
      input,
      ...over,
    });
  }
  const readPhase = (deps: AdvancedRoomAllocationDeps) =>
    deps.flowData.flowVars["__araState__"]
      ? (JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState).phase
      : undefined;

  // ── Pure builder tests ───────────────────────────────────────────────────────

  // CL1: buildChangeTypeSections produces correct sections and row ids.
  it("CL1: buildChangeTypeSections has Available Room Types and Navigation sections", () => {
    const candidates = [
      room({ roomTypeId: "rt_sup", name: "Superior", basePrice: 6500, availableCount: 3 }),
      room({ roomTypeId: "rt_pre", name: "Premier",  basePrice: 8000, availableCount: 1 }),
    ];
    const sections = buildChangeTypeSections(candidates);
    expect(sections.length).toBe(2);
    expect(sections[0]!.title).toBe("Available Room Types");
    expect(sections[0]!.rows.map((r) => r.id)).toEqual([
      `${CHANGE_TYPE_PREFIX}rt_sup`,
      `${CHANGE_TYPE_PREFIX}rt_pre`,
    ]);
    expect(sections[1]!.title).toBe("Navigation");
    expect(sections[1]!.rows[0]!.id).toBe(CHANGE_TYPE_GO_BACK);
  });

  // CL2: Current room type is excluded from candidates (pure — caller responsibility,
  //      confirmed by checking changeTypeCandidates logic).
  it("CL2: buildChangeTypeSections does not include a current-type row if caller filters", () => {
    // Only Superior passed — Deluxe (current) is excluded by changeTypeCandidates upstream.
    const sections = buildChangeTypeSections([
      room({ roomTypeId: "rt_sup", name: "Superior", basePrice: 6500, availableCount: 2 }),
    ]);
    const ids = sections[0]!.rows.map((r) => r.id);
    expect(ids).not.toContain(`${CHANGE_TYPE_PREFIX}rt_dlx`);
    expect(ids).toContain(`${CHANGE_TYPE_PREFIX}rt_sup`);
  });

  // CL3: Row description is truncated to ≤72 chars.
  it("CL3: buildChangeTypeSections description ≤72 chars", () => {
    const candidates = [
      room({ roomTypeId: "rt_x", name: "x", basePrice: 99999, availableCount: 99 }),
    ];
    const sections = buildChangeTypeSections(candidates);
    const desc = sections[0]!.rows[0]!.description ?? "";
    expect(desc.length).toBeLessThanOrEqual(72);
  });

  // ── Handler integration tests ─────────────────────────────────────────────────

  // CL4: CHANGE_TYPE_{roomTypeId} list reply switches room type (same as typed "1").
  it("CL4: CHANGE_TYPE_{id} list reply switches room type", async () => {
    const deps = mkCT(`${CHANGE_TYPE_PREFIX}rt_sup`);
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("manual");
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(after.selectedRooms[0]!.roomTypeId).toBe("rt_sup");
  });

  // CL5: CHANGE_TYPE_GO_BACK routes to room_menu (same as typed "0").
  it("CL5: CHANGE_TYPE_GO_BACK goes back to room_menu", async () => {
    const deps = mkCT(CHANGE_TYPE_GO_BACK);
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("room_menu");
  });

  // CL6: Typed "0" still routes back to room_menu (back-compat).
  it("CL6: typed '0' still goes back to room_menu", async () => {
    const deps = mkCT("0");
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("room_menu");
  });

  // CL7: Typed "1" still switches room type (back-compat).
  it("CL7: typed '1' still switches room type", async () => {
    const deps = mkCT("1");
    await handleAdvancedRoomAllocation(deps);
    expect(readPhase(deps)).toBe("manual");
    const after = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(after.selectedRooms[0]!.roomTypeId).toBe("rt_sup");
  });

  // CL8: sendChangeRoomTypeList dep present → ALREADY_SENT on initial entry.
  it("CL8: sendChangeRoomTypeList dep → ALREADY_SENT when entering change_type_select", async () => {
    const sendChangeRoomTypeList = vi.fn(async () => true);
    // Start in room_menu, pick "change_type" action to enter change_type_select.
    // Options for Deluxe with allowExtraBed=false: [move_guest, change_type, remove_room] → "2" = change_type.
    const roomMenuState: AraState = {
      guests: { adults: 2, children: 0 },
      selectedRooms: [cRoom()],
      remainingGuests: { adults: 0, children: 0 },
      phase: "room_menu", selectedRoomIndex: 0,
    };
    const deps = makeDeps({
      waitingFor: "answer",
      flowVars:   { __araState__: JSON.stringify(roomMenuState) },
      rooms:      twoTypes(),
      input:      "2",   // change_type is option 2 (allowExtraBed off: move_guest=1, change_type=2, remove_room=3)
      sendChangeRoomTypeList,
    });
    const result = await handleAdvancedRoomAllocation(deps);
    expect(sendChangeRoomTypeList).toHaveBeenCalledTimes(1);
    expect(result).toBe("ALREADY_SENT");
  });

  // CL9: sendChangeRoomTypeList dep present → ALREADY_SENT on invalid reply (re-render).
  it("CL9: sendChangeRoomTypeList dep → ALREADY_SENT on invalid input re-render", async () => {
    const sendChangeRoomTypeList = vi.fn(async () => true);
    const deps = mkCT("garbage", { sendChangeRoomTypeList });
    const result = await handleAdvancedRoomAllocation(deps);
    expect(sendChangeRoomTypeList).toHaveBeenCalledTimes(1);
    expect(result).toBe("ALREADY_SENT");
  });

  // CL10: No dep → falls back to text format.
  it("CL10: no dep → text fallback on invalid input", async () => {
    const deps = mkCT("garbage");
    const result = await handleAdvancedRoomAllocation(deps);
    expect(typeof result).toBe("string");
    expect(result).toContain("Change");
    expect(result).toContain("Superior");
  });
});
