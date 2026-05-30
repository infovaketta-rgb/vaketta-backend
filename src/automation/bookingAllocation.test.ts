import { describe, it, expect } from "vitest";
import { aggregateRoomQuantities } from "./bookingAllocation";

describe("aggregateRoomQuantities", () => {
  it("single room type, qty 1", () => {
    expect(aggregateRoomQuantities([{ roomTypeId: "rt_a" }]))
      .toEqual([{ roomTypeId: "rt_a", quantity: 1 }]);
  });

  it("same room type twice → qty 2", () => {
    expect(aggregateRoomQuantities([{ roomTypeId: "rt_a" }, { roomTypeId: "rt_a" }]))
      .toEqual([{ roomTypeId: "rt_a", quantity: 2 }]);
  });

  it("mixed types → correct per-type counts", () => {
    const result = aggregateRoomQuantities([
      { roomTypeId: "rt_a" },
      { roomTypeId: "rt_b" },
      { roomTypeId: "rt_a" },
    ]);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([
      { roomTypeId: "rt_a", quantity: 2 },
      { roomTypeId: "rt_b", quantity: 1 },
    ]));
  });

  it("skips rooms with missing/invalid roomTypeId", () => {
    expect(aggregateRoomQuantities([
      { roomTypeId: "rt_a" },
      {},
      { roomTypeId: null },
      { roomTypeId: "" },
    ])).toEqual([{ roomTypeId: "rt_a", quantity: 1 }]);
  });
});
