import type { ConfirmationStepJob } from "../workers/confirmationSequence.types";
import type { StepProgress, StepRunStatus } from "../workers/confirmationSequence.run";

// Pure helpers for the confirmation-sequence dedupe + status-recovery features.
// Kept Redis-free so they unit-test without a live queue.

// Deterministic BullMQ job id for a booking's confirmation send. Using the bookingId
// makes "is a send already in flight?" answerable, and lets a duplicate enqueue be
// detected (BullMQ rejects/ignores a second add with the same jobId while it exists).
// Separator is "-" not ":" — BullMQ disallows ":" in custom job ids.
export function confirmationJobId(bookingId: string): string {
  return `confirm-${bookingId}`;
}

export type OverallState =
  | "waiting" | "active" | "completed" | "failed" | "not_found";

export interface ConfirmationStatus {
  jobId:   string | null;
  state:   OverallState;
  steps:   StepProgress[];
  summary: { sent: number; failed: number; skipped: number } | null;
  inFlight: boolean;   // true while waiting/active — used by the dedupe guard
}

// Minimal shape of the BullMQ job fields we read (so this stays test-friendly).
export interface JobSnapshot {
  state:       string | null;            // "waiting" | "active" | "completed" | "failed" | "delayed" | null
  data:        { steps?: ConfirmationStepJob[] } | null;
  progress:    { steps?: StepProgress[] } | number | null;
  returnvalue: { sent: number; failed: number; skipped: number } | null;
}

const IN_FLIGHT = new Set(["waiting", "active", "delayed", "waiting-children"]);

// Reconstruct the per-step checklist status from whatever the job persisted. A client
// that missed live socket events calls this to re-sync after a reconnect.
export function reconstructStatus(jobId: string | null, snap: JobSnapshot | null): ConfirmationStatus {
  if (!snap || snap.state === null) {
    return { jobId, state: "not_found", steps: [], summary: null, inFlight: false };
  }

  const planSteps = snap.data?.steps ?? [];
  const progress  = (snap.progress && typeof snap.progress === "object" && "steps" in snap.progress)
    ? (snap.progress.steps ?? null)
    : null;

  // Prefer the persisted per-step progress snapshot — it's authoritative.
  let steps: StepProgress[];
  if (progress && progress.length) {
    steps = progress;
  } else {
    // No progress yet (job queued but processor hasn't written) — derive from the plan.
    // On a completed job with no progress (shouldn't happen, but be safe), treat
    // non-skipped steps as sent so the UI doesn't show a stuck "pending".
    const done = snap.state === "completed";
    steps = planSteps.map((s, i): StepProgress => ({
      stepId: s.stepId, index: i, refType: s.refType, refId: s.refId,
      status: (s.skip ? "skipped" : (done ? "sent" : "pending")) as StepRunStatus,
    }));
  }

  const inFlight = IN_FLIGHT.has(snap.state);
  const overall: OverallState =
    snap.state === "completed" ? "completed"
    : snap.state === "failed"  ? "failed"
    : snap.state === "active"  ? "active"
    : "waiting";

  return {
    jobId,
    state:    overall,
    steps,
    summary:  snap.returnvalue ?? null,
    inFlight,
  };
}
