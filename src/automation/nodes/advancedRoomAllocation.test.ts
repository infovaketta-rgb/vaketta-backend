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
  type AdvancedRoomAllocationDeps,
  type AllocationConfig,
  type AllocationRoom,
  type AllocationRoomInput,
  type AraState,
  type Adjacency,
  type FetchRoomTypesFn,
  type GetCalendarDataFn,
  type RoomConfigResolver,
} from "./advancedRoomAllocation";
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
  async function primeConfirmState(rooms: AllocationRoomInput[], flowVars: Record<string, string>) {
    const deps = makeDeps({ rooms, flowVars });
    await handleAdvancedRoomAllocation(deps);
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

  // ── 5. Modify input → phase set to "manual" ────────────────────────────────
  it("Case 5: modify input '2' switches to manual phase", async () => {
    const deps = await primeConfirmState(
      [room({ roomTypeId: "rt_std", name: "Standard", availableCount: 5 })],
      { bookingAdults: "2", bookingChildren: "0" },
    );
    deps.input = "2";
    await handleAdvancedRoomAllocation(deps);

    const stateAfter = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(stateAfter.phase).toBe("manual");
    expect(stateAfter.selectedRooms).toEqual([]);
    expect(stateAfter.remainingGuests).toEqual({ adults: 2, children: 0 });
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
  it("Case 8: multi-room confirm → bookingRoomTypeId is first room's id", async () => {
    const deps = await primeConfirmState(
      [
        room({ roomTypeId: "rt_dlx", name: "Deluxe",   basePrice: 8000, maxAdults: 4, maxChildren: 0, availableCount: 5 }),
        room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 3, maxChildren: 0, availableCount: 5 }),
      ],
      { bookingAdults: "5", bookingChildren: "0" }, // forces multi-room
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
  it("Case G4: ages stored and shown when count matches children", async () => {
    const deps = makeDeps({
      nodeData: { childrenAgesVar: "kidAges", maxChildren: 2 },
      flowVars: { bookingAdults: "2", bookingChildren: "2", kidAges: "6, 9" },
      rooms: [room({ roomTypeId: "rt_fam", name: "Family", maxAdults: 3, maxChildren: 2, availableCount: 5 })],
    });
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
    const result = await handleAdvancedRoomAllocation(deps);
    const state = JSON.parse(deps.flowData.flowVars["__araState__"]!) as AraState;
    expect(state.guests.childrenAges).toEqual([6, 9]);
    expect(result).toContain("1 child");
    expect(result).not.toContain("aged");
  });

  // 6. Back-compat — no vars set → bookingAdults / bookingChildren defaults.
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
    const state = manualState([aRoom({ roomTypeId: "rt_a" })]);
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
