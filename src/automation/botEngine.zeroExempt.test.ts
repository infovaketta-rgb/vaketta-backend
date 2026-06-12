import { describe, it, expect } from "vitest";
import { isZeroExempt } from "./zeroExempt";
import type { SessionData } from "../services/session.service";

function flowSession(flowVars: Record<string, string>, waitingFor?: "answer"): SessionData {
  return {
    flow: {
      flowId:  "flow_test",
      flowVars,
      ...(waitingFor ? { waitingFor } : {}),
    },
  };
}

function araSession(phase: string): SessionData {
  return flowSession({ __araState__: JSON.stringify({ phase }) });
}

// ZE1: non-FLOW state → never exempt.
it("ZE1: non-FLOW state is not exempt", () => {
  expect(isZeroExempt("IDLE", {})).toBe(false);
  expect(isZeroExempt("AWAITING_SELECTION", araSession("room_menu"))).toBe(false);
  expect(isZeroExempt("ENQUIRY_OPEN", araSession("move_to_room"))).toBe(false);
});

// ZE2: FLOW state with no ARA state and no __questionType__ → not exempt.
it("ZE2: FLOW state without ARA or question tag is not exempt", () => {
  expect(isZeroExempt("FLOW:flow1:node1", flowSession({}))).toBe(false);
});

// ZE3: ARA modification phases → exempt.
describe("ZE3: ARA modification phases are exempt", () => {
  const exemptPhases = ["room_menu", "move_to_room", "change_type_select", "move_from_count"];
  for (const phase of exemptPhases) {
    it(`phase "${phase}"`, () => {
      expect(isZeroExempt("FLOW:flow1:node1", araSession(phase))).toBe(true);
    });
  }
});

// ZE4: ARA non-modification phases → not exempt.
describe("ZE4: ARA non-modification phases are not exempt", () => {
  const nonExempt = ["confirm", "manual", "plan_selection", "collecting_ages", "collecting_room_preference"];
  for (const phase of nonExempt) {
    it(`phase "${phase}"`, () => {
      expect(isZeroExempt("FLOW:flow1:node1", araSession(phase))).toBe(false);
    });
  }
});

// ZE5: question number node awaiting answer → exempt.
it("ZE5: question node with __questionType__=number and waitingFor=answer is exempt", () => {
  const data = flowSession({ __questionType__: "number" }, "answer");
  expect(isZeroExempt("FLOW:flow1:node1", data)).toBe(true);
});

// ZE6: question number tag present but NOT waitingFor → not exempt (answer already processed).
it("ZE6: __questionType__=number without waitingFor is not exempt", () => {
  const data = flowSession({ __questionType__: "number" });
  expect(isZeroExempt("FLOW:flow1:node1", data)).toBe(false);
});

// ZE7: corrupted __araState__ JSON → falls through, not exempt.
it("ZE7: corrupted __araState__ does not throw and is not exempt", () => {
  const data = flowSession({ __araState__: "not-json" });
  expect(isZeroExempt("FLOW:flow1:node1", data)).toBe(false);
});
