import { describe, it, expect } from "vitest";
import {
  indexVarProducers,
  planRetry,
  chooseDateFieldToRetry,
  getRetryCount,
  bumpRetryCount,
  clearRetryCount,
  clearAllRetryCounts,
  retriesExhausted,
  retryCountKey,
  MAX_STEP_RETRIES,
  type IndexableNode,
} from "./stepRetry";

/** A realistic booking flow: name → check-in → check-out → guests → rooms. */
const FLOW: IndexableNode[] = [
  { id: "n_start", type: "start", data: {} },
  { id: "n_name", type: "question", data: { questionType: "text", variableName: "guestFullName" } },
  { id: "n_in", type: "question", data: { questionType: "date", variableName: "stayCheckIn" } },
  { id: "n_out", type: "question", data: { questionType: "date", variableName: "stayCheckOut" } },
  { id: "n_adults", type: "question", data: { questionType: "number", variableName: "bookingAdults" } },
  { id: "n_rooms", type: "show_rooms", data: { variableName: "booking" } },
  { id: "n_msg", type: "message", data: { text: "thanks" } },
];

describe("indexVarProducers", () => {
  const idx = indexVarProducers(FLOW);

  it("maps each collected variable to its producing node", () => {
    expect(idx.get("guestFullName")).toBe("n_name");
    expect(idx.get("stayCheckIn")).toBe("n_in");
    expect(idx.get("stayCheckOut")).toBe("n_out");
    expect(idx.get("bookingAdults")).toBe("n_adults");
  });

  it("maps the canonical date aliases to the right date question", () => {
    // These are what create_booking and the ARA node actually read.
    expect(idx.get("bookingCheckIn")).toBe("n_in");
    expect(idx.get("bookingCheckOut")).toBe("n_out");
  });

  it("maps every variable a show_rooms node produces, including canonicals", () => {
    expect(idx.get("bookingTypeId")).toBe("n_rooms");
    expect(idx.get("bookingTypeName")).toBe("n_rooms");
    expect(idx.get("bookingPrice")).toBe("n_rooms");
    expect(idx.get("bookingRoomTypeId")).toBe("n_rooms");
    expect(idx.get("bookingRoomTypeName")).toBe("n_rooms");
    expect(idx.get("bookingPricePerNight")).toBe("n_rooms");
  });

  it("ignores non-collecting nodes and nodes with no variableName", () => {
    expect(idx.has("text")).toBe(false);
    expect([...idx.values()]).not.toContain("n_msg");
    expect([...idx.values()]).not.toContain("n_start");
  });

  it("lets a later node win when two nodes write the same variable", () => {
    const dup = indexVarProducers([
      { id: "first", type: "question", data: { questionType: "text", variableName: "v" } },
      { id: "second", type: "question", data: { questionType: "text", variableName: "v" } },
    ]);
    expect(dup.get("v")).toBe("second");
  });

  it("handles legacy room_selection questions", () => {
    const legacy = indexVarProducers([
      { id: "rs", type: "question", data: { questionType: "room_selection", variableName: "stay" } },
    ]);
    expect(legacy.get("stayTypeId")).toBe("rs");
    expect(legacy.get("bookingRoomTypeId")).toBe("rs");
  });

  it("tolerates malformed nodes without throwing", () => {
    expect(() =>
      indexVarProducers([
        { id: "a" },
        { id: "b", type: "question", data: null },
        { id: "c", type: "question", data: { variableName: "   " } },
        { id: "d", type: "question", data: { variableName: 42 as unknown as string } },
      ]),
    ).not.toThrow();
  });
});

describe("planRetry", () => {
  const idx = indexVarProducers(FLOW);
  const vars = {
    guestFullName: "Priya",
    stayCheckIn: "2026-08-01",
    stayCheckOut: "2026-07-30", // the bad value
    bookingCheckIn: "2026-08-01",
    bookingCheckOut: "2026-07-30",
    bookingAdults: "2",
    bookingRoomTypeId: "rt_1",
    bookingPricePerNight: "4500",
  };

  it("targets the node that collected the offending variable", () => {
    const plan = planRetry("bookingCheckOut", vars, idx, "fix it")!;
    expect(plan.nodeId).toBe("n_out");
    expect(plan.message).toBe("fix it");
  });

  it("PRESERVES every other answer — the whole point of the change", () => {
    const plan = planRetry("bookingCheckOut", vars, idx, "fix it")!;
    expect(plan.flowVars.guestFullName).toBe("Priya");
    expect(plan.flowVars.stayCheckIn).toBe("2026-08-01");
    expect(plan.flowVars.bookingCheckIn).toBe("2026-08-01");
    expect(plan.flowVars.bookingAdults).toBe("2");
    expect(plan.flowVars.bookingRoomTypeId).toBe("rt_1");
  });

  it("clears the offending value AND its alias so the retry can't read stale data", () => {
    const plan = planRetry("bookingCheckOut", vars, idx, "fix it")!;
    expect(plan.flowVars.bookingCheckOut).toBeUndefined();
    expect(plan.flowVars.stayCheckOut).toBeUndefined();
  });

  it("clears every variable the same node produced (stale room price)", () => {
    const plan = planRetry("bookingRoomTypeId", vars, idx, "sold out")!;
    expect(plan.nodeId).toBe("n_rooms");
    expect(plan.flowVars.bookingRoomTypeId).toBeUndefined();
    expect(plan.flowVars.bookingPricePerNight).toBeUndefined();
    // ...but the dates and name survive.
    expect(plan.flowVars.bookingCheckIn).toBe("2026-08-01");
    expect(plan.flowVars.guestFullName).toBe("Priya");
  });

  it("returns null for a variable no node produces, so the caller can fall back", () => {
    expect(planRetry("somethingElse", vars, idx, "x")).toBeNull();
  });

  it("does not mutate the flowVars it was given", () => {
    const before = { ...vars };
    planRetry("bookingCheckOut", vars, idx, "fix it");
    expect(vars).toEqual(before);
  });
});

describe("chooseDateFieldToRetry", () => {
  it("prefers check-out — the later answer and the usual mistake", () => {
    const idx = indexVarProducers(FLOW);
    expect(chooseDateFieldToRetry(idx)).toBe("bookingCheckOut");
  });

  it("falls back to check-in when only that is rewindable", () => {
    const idx = indexVarProducers([
      { id: "n_in", type: "question", data: { questionType: "date", variableName: "myCheckIn" } },
    ]);
    expect(chooseDateFieldToRetry(idx)).toBe("bookingCheckIn");
  });

  it("returns null when neither date is rewindable", () => {
    expect(chooseDateFieldToRetry(new Map())).toBeNull();
  });
});

describe("retry budget", () => {
  it("counts up and reports exhaustion at the cap", () => {
    let vars: Record<string, string> = {};
    expect(getRetryCount(vars, "d")).toBe(0);
    expect(retriesExhausted(vars, "d")).toBe(false);

    for (let i = 1; i <= MAX_STEP_RETRIES; i++) {
      vars = bumpRetryCount(vars, "d");
      expect(getRetryCount(vars, "d")).toBe(i);
    }
    expect(retriesExhausted(vars, "d")).toBe(true);
  });

  it("tracks each variable independently", () => {
    let vars = bumpRetryCount({}, "a");
    vars = bumpRetryCount(vars, "a");
    vars = bumpRetryCount(vars, "b");
    expect(getRetryCount(vars, "a")).toBe(2);
    expect(getRetryCount(vars, "b")).toBe(1);
  });

  it("refunds the budget when the step finally succeeds", () => {
    let vars = bumpRetryCount({}, "d");
    vars = bumpRetryCount(vars, "d");
    vars = clearRetryCount(vars, "d");
    expect(getRetryCount(vars, "d")).toBe(0);
    expect(retryCountKey("d") in vars).toBe(false);
  });

  it("strips all tallies without touching real answers", () => {
    const vars = { guestName: "Ada", ...bumpRetryCount({}, "d"), ...bumpRetryCount({}, "e") };
    const cleaned = clearAllRetryCounts(vars);
    expect(cleaned).toEqual({ guestName: "Ada" });
  });

  it("treats a corrupted tally as zero rather than throwing", () => {
    expect(getRetryCount({ [retryCountKey("d")]: "not-a-number" }, "d")).toBe(0);
    expect(getRetryCount({ [retryCountKey("d")]: "-5" }, "d")).toBe(0);
  });

  it("bumping does not mutate the input", () => {
    const vars = {};
    bumpRetryCount(vars, "d");
    expect(vars).toEqual({});
  });
});

describe("end-to-end: the reported scenario", () => {
  it("a reversed check-out re-asks only that date and keeps everything else", () => {
    const idx = indexVarProducers(FLOW);
    const collected = {
      guestFullName: "Priya",
      stayCheckIn: "2026-08-10",
      bookingCheckIn: "2026-08-10",
      stayCheckOut: "2026-08-09", // before check-in
      bookingCheckOut: "2026-08-09",
      bookingAdults: "3",
    };

    const field = chooseDateFieldToRetry(idx)!;
    const plan = planRetry(field, collected, idx, "Check-out must be after check-in.")!;

    // Rewinds to the check-out question, not the start of the flow.
    expect(plan.nodeId).toBe("n_out");
    // The guest keeps their name, check-in and party size.
    expect(plan.flowVars).toEqual({
      guestFullName: "Priya",
      stayCheckIn: "2026-08-10",
      bookingCheckIn: "2026-08-10",
      bookingAdults: "3",
    });
  });

  it("gives up only after the retry budget is spent", () => {
    let vars: Record<string, string> = { bookingCheckOut: "bad" };
    for (let i = 0; i < MAX_STEP_RETRIES; i++) {
      expect(retriesExhausted(vars, "bookingCheckOut")).toBe(false);
      vars = bumpRetryCount(vars, "bookingCheckOut");
    }
    // Now the engine falls back to its terminal reset — always an exit.
    expect(retriesExhausted(vars, "bookingCheckOut")).toBe(true);
  });
});
