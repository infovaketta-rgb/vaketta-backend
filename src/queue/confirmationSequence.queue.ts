import { Queue } from "bullmq";
import { redis } from "./redis";

// Drives a staff-confirmed confirmation sequence: sends the selected steps in order,
// sequentially, one job per booking confirmation. attempts:1 mirrors flow-resume —
// a retry would re-send already-delivered guest messages (no idempotency per step),
// so a partial failure is surfaced via per-step Socket.IO events instead of retried.
export const confirmationSequenceQueue = new Queue("confirmation-sequence", {
  connection: redis,
  defaultJobOptions: {
    attempts:         1,
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50  },
  },
});
