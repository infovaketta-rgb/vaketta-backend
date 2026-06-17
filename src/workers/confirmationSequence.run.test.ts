/**
 * Tests for runConfirmationSequence — the pure, dependency-injected core of the
 * confirmation-sequence worker. No Redis / Meta / Prisma: senders + emit are mocked.
 * Covers skip behaviour, step ordering, and the critical invariant that one step's
 * failure does NOT abort the remaining steps.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageChannel } from "@prisma/client";

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

import { runConfirmationSequence, type StepDeps } from "./confirmationSequence.run";
import type { ConfirmationSequenceJobData } from "./confirmationSequence.types";

function makeDeps(over: Partial<StepDeps> = {}): StepDeps & { events: any[]; progressSnaps: any[] } {
  const events: any[] = [];
  const progressSnaps: any[] = [];
  return {
    sendTemplate:       vi.fn(async () => ({})),
    sendSavedReply:     vi.fn(async () => ({})),
    loadSavedReplyBody: vi.fn(async () => "Hi {{guestName}}"),
    emit:               (_h: string, event: string, payload: any) => { events.push({ event, payload }); },
    // Snapshot a deep copy each call — the run mutates the array in place.
    reportProgress:     (steps) => { progressSnaps.push(steps.map((s) => ({ ...s }))); },
    events,
    progressSnaps,
    ...over,
  };
}

function job(steps: ConfirmationSequenceJobData["steps"]): ConfirmationSequenceJobData {
  return {
    hotelId: "h1", bookingId: "b1", guestId: "g1",
    guestPhone: "+100", fromPhone: "+200",
    channel: MessageChannel.WHATSAPP,
    vars: { guestName: "Sam" },
    steps,
  };
}

describe("runConfirmationSequence", () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => { deps = makeDeps(); });

  it("sends template + saved-reply steps in order", async () => {
    const summary = await runConfirmationSequence(job([
      { stepId: "s0", refType: "TEMPLATE",    refId: "tmpl1", skip: false },
      { stepId: "s1", refType: "SAVED_REPLY", refId: "sr1",   skip: false },
    ]), deps);

    expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(deps.sendTemplate).toHaveBeenCalledWith("h1", "g1", "tmpl1", { guestName: "Sam" });
    // saved reply body was loaded + interpolated before send
    expect(deps.loadSavedReplyBody).toHaveBeenCalledWith("h1", "sr1");
    expect((deps.sendSavedReply as any).mock.calls[0][0].text).toBe("Hi Sam");

    const statuses = deps.events.filter((e) => e.event === "confirmation:step").map((e) => e.payload.status);
    expect(statuses).toEqual(["sending", "sent", "sending", "sent"]);
    const done = deps.events.find((e) => e.event === "confirmation:done");
    expect(done.payload).toMatchObject({ sent: 2, failed: 0, skipped: 0 });
  });

  it("persists a per-step progress snapshot at each transition (for reconnect recovery)", async () => {
    await runConfirmationSequence(job([
      { stepId: "s0", refType: "TEMPLATE",    refId: "tmpl1", skip: false },
      { stepId: "s1", refType: "SAVED_REPLY", refId: "sr1",   skip: true  },
    ]), deps);

    // First snapshot is the all-pending baseline...
    expect(deps.progressSnaps[0].map((s: any) => s.status)).toEqual(["pending", "pending"]);
    // ...and the final snapshot reflects the terminal state of every step.
    const last = deps.progressSnaps[deps.progressSnaps.length - 1];
    expect(last.map((s: any) => s.status)).toEqual(["sent", "skipped"]);
  });

  it("runs fine without reportProgress (optional dep)", async () => {
    const noProg = makeDeps();
    delete (noProg as Partial<StepDeps>).reportProgress;
    const summary = await runConfirmationSequence(job([
      { stepId: "s0", refType: "TEMPLATE", refId: "tmpl1", skip: false },
    ]), noProg);
    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0 });
  });

  it("skips steps marked skip:true (no send, emits 'skipped')", async () => {
    const summary = await runConfirmationSequence(job([
      { stepId: "s0", refType: "TEMPLATE",    refId: "tmpl1", skip: true  },
      { stepId: "s1", refType: "SAVED_REPLY", refId: "sr1",   skip: false },
    ]), deps);

    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(deps.sendTemplate).not.toHaveBeenCalled();
    expect(deps.sendSavedReply).toHaveBeenCalledTimes(1);
    const first = deps.events.find((e) => e.event === "confirmation:step");
    expect(first.payload).toMatchObject({ status: "skipped", stepId: "s0" });
  });

  it("does NOT abort subsequent steps when a step fails", async () => {
    deps = makeDeps({
      sendTemplate: vi.fn(async () => { throw new Error("Meta 500"); }),
      sendSavedReply: vi.fn(async () => ({})),
    });

    const summary = await runConfirmationSequence(job([
      { stepId: "s0", refType: "TEMPLATE",    refId: "tmpl1", skip: false }, // fails
      { stepId: "s1", refType: "SAVED_REPLY", refId: "sr1",   skip: false }, // must still run
      { stepId: "s2", refType: "SAVED_REPLY", refId: "sr2",   skip: false }, // must still run
    ]), deps);

    expect(summary).toEqual({ sent: 2, failed: 1, skipped: 0 });
    expect(deps.sendSavedReply).toHaveBeenCalledTimes(2); // both later steps ran
    const failed = deps.events.find((e) => e.event === "confirmation:step" && e.payload.status === "failed");
    expect(failed.payload).toMatchObject({ stepId: "s0", error: "Meta 500" });
    // The two saved replies after the failure both reported "sent".
    const sentIds = deps.events
      .filter((e) => e.event === "confirmation:step" && e.payload.status === "sent")
      .map((e) => e.payload.stepId);
    expect(sentIds).toEqual(["s1", "s2"]);
  });

  it("marks a step failed when the saved reply no longer exists", async () => {
    deps = makeDeps({ loadSavedReplyBody: vi.fn(async () => null) });
    const summary = await runConfirmationSequence(job([
      { stepId: "s0", refType: "SAVED_REPLY", refId: "gone", skip: false },
    ]), deps);
    expect(summary).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(deps.sendSavedReply).not.toHaveBeenCalled();
  });
});
