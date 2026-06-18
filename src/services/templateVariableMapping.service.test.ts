/**
 * Tests for templateVariableMapping.service.ts — the watched-var registry, the pure
 * pickWatchedFlowVars subset helper, and the flow-var-name enumerator.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/connect", () => ({
  default: {
    templateVariableMapping: { findMany: vi.fn() },
    flowDefinition:          { findMany: vi.fn() },
  },
}));

import prisma from "../db/connect";
import {
  getWatchedFlowVarNames,
  pickWatchedFlowVars,
  getHotelFlowVarNames,
} from "./templateVariableMapping.service";

const tvm = (prisma as any).templateVariableMapping.findMany as ReturnType<typeof vi.fn>;
const flowDef = (prisma as any).flowDefinition.findMany as ReturnType<typeof vi.fn>;

beforeEach(() => { vi.clearAllMocks(); });

// ── pickWatchedFlowVars (pure) ───────────────────────────────────────────────────

describe("pickWatchedFlowVars", () => {
  const flowVars = { arrivalTime: "2 PM", numberOfGuests: "4", guestName: "Sam" };

  it("returns only the watched subset", () => {
    expect(pickWatchedFlowVars(flowVars, ["arrivalTime", "numberOfGuests"]))
      .toEqual({ arrivalTime: "2 PM", numberOfGuests: "4" });
  });

  it("skips watched names not present in flowVars", () => {
    expect(pickWatchedFlowVars(flowVars, ["arrivalTime", "missing"]))
      .toEqual({ arrivalTime: "2 PM" });
  });

  it("returns null when nothing matches (so the column stays null, not {})", () => {
    expect(pickWatchedFlowVars(flowVars, ["nope"])).toBeNull();
    expect(pickWatchedFlowVars(flowVars, [])).toBeNull();
  });
});

// ── getWatchedFlowVarNames ───────────────────────────────────────────────────────

describe("getWatchedFlowVarNames", () => {
  it("returns distinct FLOW_VAR sourceKeys scoped to the hotel", async () => {
    tvm.mockResolvedValue([{ sourceKey: "arrivalTime" }, { sourceKey: "numberOfGuests" }]);
    const names = await getWatchedFlowVarNames("h1");

    expect(names).toEqual(["arrivalTime", "numberOfGuests"]);
    // hotel-scoped + FLOW_VAR-only + distinct on sourceKey
    expect(tvm.mock.calls[0]![0]).toMatchObject({
      where:    { hotelId: "h1", sourceType: "FLOW_VAR" },
      distinct: ["sourceKey"],
    });
  });

  it("returns [] when the hotel watches nothing", async () => {
    tvm.mockResolvedValue([]);
    expect(await getWatchedFlowVarNames("h1")).toEqual([]);
  });
});

// ── getHotelFlowVarNames ─────────────────────────────────────────────────────────

describe("getHotelFlowVarNames", () => {
  it("merges system vars with node variableName/variableToSet, distinct + sorted", async () => {
    flowDef.mockResolvedValue([
      { nodes: [
        { type: "question",     data: { variableName: "arrivalTime" } },
        { type: "options",      data: { variableName: "mealPlan" } },
        { type: "action",       data: { variableToSet: "vipFlag" } },
        { type: "message",      data: { text: "hi" } },          // no var key
        { type: "question",     data: { variableName: "arrivalTime" } }, // dup
      ] },
    ]);

    const names = await getHotelFlowVarNames("h1");

    // system vars present
    expect(names).toContain("guestName");
    expect(names).toContain("hotelName");
    // collected vars present, de-duped
    expect(names).toContain("arrivalTime");
    expect(names).toContain("mealPlan");
    expect(names).toContain("vipFlag");
    expect(names.filter((n) => n === "arrivalTime")).toHaveLength(1);
    // sorted
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(flowDef.mock.calls[0]![0].where).toEqual({ hotelId: "h1" });
  });

  it("returns just the system vars when the hotel has no flows", async () => {
    flowDef.mockResolvedValue([]);
    const names = await getHotelFlowVarNames("h1");
    expect(names).toContain("guestName");
    expect(names).not.toContain("arrivalTime");
  });
});
