import type { MessageChannel } from "@prisma/client";
import { logger } from "../utils/logger";
import { interpolate } from "../automation/interpolate";
import type { ConfirmationSequenceJobData } from "./confirmationSequence.types";

// Pure core of the confirmation-sequence worker — NO Redis/BullMQ/Meta imports, so it
// can be unit-tested directly. The worker module wires the real senders + emit and
// hands them in as `deps`. (Kept separate from the worker for the same reason
// planList.ts is kept out of flowRuntime: avoid the Redis-at-import chain in tests.)

const log = logger.child({ service: "confirmation-sequence" });

// Per-step send timeout. Mirrors flowRuntime's withActionTimeout EXACTLY, including
// the leak-safe `.finally(() => clearTimeout(timer!))`.
const STEP_TIMEOUT_MS = 15_000;
export function withStepTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Step timeout")), STEP_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

// Live per-step status, also persisted to the BullMQ job's progress so a client that
// missed socket events (disconnect/reconnect) can reconstruct the current state.
export type StepRunStatus = "pending" | "sending" | "sent" | "failed" | "skipped";
export interface StepProgress {
  stepId:  string;
  index:   number;
  refType: "TEMPLATE" | "SAVED_REPLY";
  refId:   string;
  status:  StepRunStatus;
  error?:  string;
}

// Injectable senders + emitter so the core loop is testable without Redis/Meta.
export interface StepDeps {
  sendTemplate: (hotelId: string, guestId: string, templateId: string, vars: Record<string, string>) => Promise<unknown>;
  sendSavedReply: (input: {
    channel: MessageChannel; toPhone: string; fromPhone: string; hotelId: string; guestId: string; text: string;
  }) => Promise<unknown>;
  loadSavedReplyBody: (hotelId: string, savedReplyId: string) => Promise<string | null>;
  emit: (hotelId: string, event: string, payload: any) => void;
  // Optional — persist the full per-step status snapshot (e.g. job.updateProgress).
  // Absent in tests that don't care about durable progress.
  reportProgress?: (steps: StepProgress[]) => Promise<void> | void;
}

/**
 * Sends the selected confirmation-sequence steps in order, sequentially. Each step:
 *   - if skip → emit "skipped", continue.
 *   - else send (template or saved-reply), wrapped in withStepTimeout + try/catch.
 *   - emit "sent" or "failed" per step.
 * A step failure is logged and DOES NOT abort the remaining steps.
 */
export async function runConfirmationSequence(
  data: ConfirmationSequenceJobData,
  deps: StepDeps
): Promise<{ sent: number; failed: number; skipped: number }> {
  const { hotelId, bookingId, guestId, guestPhone, fromPhone, channel, vars, steps } = data;
  let sent = 0, failed = 0, skipped = 0;

  // Durable snapshot — every step starts "pending"; updated in place as we go and
  // persisted via reportProgress so a reconnecting client can rebuild the UI.
  const progress: StepProgress[] = steps.map((s, i) => ({
    stepId: s.stepId, index: i, refType: s.refType, refId: s.refId, status: "pending",
  }));
  const persist = async () => { if (deps.reportProgress) await deps.reportProgress(progress); };
  await persist();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const base = { stepId: step.stepId, index: i, refType: step.refType, refId: step.refId };

    if (step.skip) {
      skipped++;
      progress[i]!.status = "skipped";
      await persist();
      deps.emit(hotelId, "confirmation:step", { bookingId, ...base, status: "skipped" });
      continue;
    }

    progress[i]!.status = "sending";
    await persist();
    deps.emit(hotelId, "confirmation:step", { bookingId, ...base, status: "sending" });

    try {
      if (step.refType === "TEMPLATE") {
        // Booking-level auto-fill is the base; per-step staff-filled values win.
        const sendVars = { ...vars, ...(step.variables ?? {}) };
        await withStepTimeout(deps.sendTemplate(hotelId, guestId, step.refId, sendVars));
      } else {
        const body = await deps.loadSavedReplyBody(hotelId, step.refId);
        if (body === null) throw new Error("Saved reply not found");
        const text = interpolate(body, vars);
        await withStepTimeout(deps.sendSavedReply({ channel, toPhone: guestPhone, fromPhone, hotelId, guestId, text }));
      }
      sent++;
      progress[i]!.status = "sent";
      await persist();
      deps.emit(hotelId, "confirmation:step", { bookingId, ...base, status: "sent" });
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "send failed";
      progress[i]!.status = "failed";
      progress[i]!.error  = message;
      await persist();
      // Never swallow silently — log with full context, then continue to next step.
      log.error({ err, step: base, hotelId, bookingId }, "confirmation sequence step failed");
      deps.emit(hotelId, "confirmation:step", { bookingId, ...base, status: "failed", error: message });
    }
  }

  deps.emit(hotelId, "confirmation:done", { bookingId, sent, failed, skipped });
  return { sent, failed, skipped };
}
