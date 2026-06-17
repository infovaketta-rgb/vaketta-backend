/**
 * Tests for confirmationStatus.ts — the pure dedupe id + status-reconstruction
 * helpers used by the confirmation-status endpoint and the double-submit guard.
 */

import { describe, it, expect } from "vitest";
import { confirmationJobId, reconstructStatus, type JobSnapshot } from "./confirmationStatus";

describe("confirmationJobId", () => {
  it("is deterministic per booking", () => {
    expect(confirmationJobId("b1")).toBe("confirm-b1");
    expect(confirmationJobId("b1")).toBe(confirmationJobId("b1"));
    expect(confirmationJobId("b2")).not.toBe(confirmationJobId("b1"));
  });
});

const plan = [
  { stepId: "s0", refType: "TEMPLATE"    as const, refId: "t1",  skip: false },
  { stepId: "s1", refType: "SAVED_REPLY" as const, refId: "sr1", skip: true  },
  { stepId: "s2", refType: "SAVED_REPLY" as const, refId: "sr2", skip: false },
];

describe("reconstructStatus", () => {
  it("returns not_found when no job exists", () => {
    const r = reconstructStatus("confirm-b1", null);
    expect(r).toMatchObject({ state: "not_found", steps: [], inFlight: false });
  });

  it("returns not_found when the job state is null (evicted)", () => {
    const r = reconstructStatus("confirm-b1", { state: null, data: { steps: plan }, progress: null, returnvalue: null });
    expect(r.state).toBe("not_found");
  });

  it("prefers the persisted per-step progress snapshot", () => {
    const snap: JobSnapshot = {
      state: "active",
      data: { steps: plan },
      progress: { steps: [
        { stepId: "s0", index: 0, refType: "TEMPLATE",    refId: "t1",  status: "sent"    },
        { stepId: "s1", index: 1, refType: "SAVED_REPLY", refId: "sr1", status: "skipped" },
        { stepId: "s2", index: 2, refType: "SAVED_REPLY", refId: "sr2", status: "sending" },
      ] },
      returnvalue: null,
    };
    const r = reconstructStatus("confirm-b1", snap);
    expect(r.state).toBe("active");
    expect(r.inFlight).toBe(true);
    expect(r.steps.map((s) => s.status)).toEqual(["sent", "skipped", "sending"]);
  });

  it("derives pending/skipped from the plan when no progress yet (waiting)", () => {
    const snap: JobSnapshot = { state: "waiting", data: { steps: plan }, progress: null, returnvalue: null };
    const r = reconstructStatus("confirm-b1", snap);
    expect(r.state).toBe("waiting");
    expect(r.inFlight).toBe(true);
    // skip step → "skipped"; others → "pending" until the processor writes progress
    expect(r.steps.map((s) => s.status)).toEqual(["pending", "skipped", "pending"]);
  });

  it("treats a completed job with no progress as all-sent (non-skipped)", () => {
    const snap: JobSnapshot = {
      state: "completed", data: { steps: plan }, progress: null,
      returnvalue: { sent: 2, failed: 0, skipped: 1 },
    };
    const r = reconstructStatus("confirm-b1", snap);
    expect(r.state).toBe("completed");
    expect(r.inFlight).toBe(false);
    expect(r.steps.map((s) => s.status)).toEqual(["sent", "skipped", "sent"]);
    expect(r.summary).toEqual({ sent: 2, failed: 0, skipped: 1 });
  });

  it("surfaces a failed overall state with its progress + summary", () => {
    const snap: JobSnapshot = {
      state: "completed",
      data: { steps: plan },
      progress: { steps: [
        { stepId: "s0", index: 0, refType: "TEMPLATE",    refId: "t1",  status: "failed", error: "Meta 500" },
        { stepId: "s1", index: 1, refType: "SAVED_REPLY", refId: "sr1", status: "skipped" },
        { stepId: "s2", index: 2, refType: "SAVED_REPLY", refId: "sr2", status: "sent" },
      ] },
      returnvalue: { sent: 1, failed: 1, skipped: 1 },
    };
    const r = reconstructStatus("confirm-b1", snap);
    expect(r.steps[0]).toMatchObject({ status: "failed", error: "Meta 500" });
    expect(r.summary).toEqual({ sent: 1, failed: 1, skipped: 1 });
  });
});
