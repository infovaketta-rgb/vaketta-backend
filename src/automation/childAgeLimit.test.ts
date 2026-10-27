import { describe, it, expect } from "vitest";
import {
  parseChildAgeLimit,
  DEFAULT_CHILD_AGE_LIMIT,
  MIN_CHILD_AGE_LIMIT,
  MAX_CHILD_AGE_LIMIT,
} from "./childAgeLimit";

const ERROR = "Child age limit must be a whole number from 0 to 17.";

describe("childAgeLimit constants", () => {
  it("default 12 (the schema default), bounds 0–17", () => {
    expect(DEFAULT_CHILD_AGE_LIMIT).toBe(12);
    expect(MIN_CHILD_AGE_LIMIT).toBe(0);
    expect(MAX_CHILD_AGE_LIMIT).toBe(17);
  });
});

describe("parseChildAgeLimit", () => {
  it.each([0, 12, 17])("accepts %j", (v) => {
    expect(parseChildAgeLimit(v)).toEqual({ ok: true, value: v });
  });

  it.each([
    ["-1 (below range)", -1],
    ["18 (above range)", 18],
    ["12.5 (decimal)", 12.5],
    ['"12" (string)', "12"],
    ["null", null],
    ["undefined", undefined],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["true (boolean)", true],
    ["{} (object)", {}],
  ])("rejects %s with a readable message — never clamps", (_label, v) => {
    expect(parseChildAgeLimit(v)).toEqual({ ok: false, error: ERROR });
  });
});
