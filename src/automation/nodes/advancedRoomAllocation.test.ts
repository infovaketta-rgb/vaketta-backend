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
  type AdvancedRoomAllocationDeps,
  type AllocationConfig,
  type AllocationRoom,
  type AllocationRoomInput,
  type AraState,
  type Adjacency,
  type FetchRoomTypesFn,
  type GetCalendarDataFn,
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

  // ── 2. 4 adults, allowExtraBed=true — extra bed applied in single room ─────
  it("Case 2: 4 adults, maxAdults=3 allowExtraBed=true — extra bed applied", () => {
    const result = allocateRooms({
      adults: 4, children: 0,
      rooms: [room({ roomTypeId: "rt_dlx", name: "Deluxe", basePrice: 8000, maxAdults: 5, maxChildren: 2 })],
      config: { ...baseConfig, allowExtraBed: true, extraAdultCharge: 500 },
      nights: 2,
    });
    expect(result).toHaveLength(1);
    expect(result![0]!.adults).toBe(4);
    expect(result![0]!.extraBed).toBe(true);
    // extraAdults = 4 - 2 (baseAdults) = 2 → pricePerNight = 8000 + 2 * 500 = 9000
    expect(result![0]!.pricePerNight).toBe(9000);
    expect(result![0]!.totalPrice).toBe(18000);
  });

  // ── 3. 4 adults, allowExtraBed=false — falls back to a second room ──────────
  it("Case 3: 4 adults, maxAdults=3 allowExtraBed=false — second room allocated", () => {
    const result = allocateRooms({
      adults: 4, children: 0,
      rooms: [room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 5, maxChildren: 2, availableCount: 5 })],
      config: { ...baseConfig, allowExtraBed: false },
      nights: 1,
    });
    expect(result).toHaveLength(2);
    expect(result![0]!.adults).toBe(3); // effective cap = 3
    expect(result![1]!.adults).toBe(1);
    expect(result![0]!.extraBed).toBe(true);  // 3 > baseAdults(2)
    expect(result![1]!.extraBed).toBe(false); // 1 not > 2
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

  // ── 9. Availability constraint — fall back to alternative room type ────────
  it("Case 9: respects availableCount, falls back to alt room type", () => {
    const result = allocateRooms({
      adults: 9, children: 0,
      rooms: [
        room({ roomTypeId: "rt_dlx", name: "Deluxe",   basePrice: 8000, maxAdults: 4, maxChildren: 0, availableCount: 2 }),
        room({ roomTypeId: "rt_std", name: "Standard", basePrice: 6000, maxAdults: 3, maxChildren: 0, availableCount: 5 }),
      ],
      config: { ...baseConfig, allowExtraBed: false, maxAdults: 4 },
      nights: 1,
    })!;
    const deluxeCount = result.filter((r) => r.roomTypeId === "rt_dlx").length;
    expect(deluxeCount).toBe(2); // capped by availableCount=2
    // Remaining 1 adult goes into a Standard
    const standardCount = result.filter((r) => r.roomTypeId === "rt_std").length;
    expect(standardCount).toBeGreaterThanOrEqual(1);
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
    expect(result[0]!.extraBed).toBe(true);  // 3 > baseAdults(2)
    expect(result[0]!.extraBedCost).toBe(0); // but charge not applied
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
