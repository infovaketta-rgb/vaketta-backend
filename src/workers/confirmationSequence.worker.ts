import { Worker } from "bullmq";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";
import { emitToHotel } from "../realtime/emit";
import { sendTemplateMessage } from "../services/templates.service";
import { sendChannelMessage } from "../services/channel.send.service";
import { runConfirmationSequence, type StepDeps } from "./confirmationSequence.run";
import type { ConfirmationSequenceJobData } from "./confirmationSequence.types";

// Re-export job-payload + run types so existing importers keep working.
export type { ConfirmationStepJob, ConfirmationSequenceJobData } from "./confirmationSequence.types";
export { runConfirmationSequence, type StepDeps } from "./confirmationSequence.run";

const log = logger.child({ service: "confirmation-sequence-worker" });

// Real dependency wiring. Built per-job so reportProgress can write to THIS job's
// BullMQ progress (read back by GET /bookings/:id/confirmation-status on reconnect).
function buildDeps(job: { updateProgress: (p: any) => Promise<void> }): StepDeps {
  return {
    sendTemplate:   (hotelId, guestId, templateId, vars) => sendTemplateMessage(hotelId, guestId, templateId, vars),
    sendSavedReply: (input) => sendChannelMessage(input),
    loadSavedReplyBody: async (hotelId, savedReplyId) => {
      const sr = await prisma.savedReply.findFirst({ where: { id: savedReplyId, hotelId }, select: { body: true } });
      return sr?.body ?? null;
    },
    emit: emitToHotel,
    reportProgress: async (steps) => {
      // Best-effort — a progress-write failure must never abort the send.
      try { await job.updateProgress({ steps }); } catch (err) { log.warn({ err }, "updateProgress failed"); }
    },
  };
}

const worker = new Worker(
  "confirmation-sequence",
  async (job) => {
    const data = job.data as ConfirmationSequenceJobData;
    const summary = await runConfirmationSequence(data, buildDeps(job));
    log.info({ bookingId: data.bookingId, hotelId: data.hotelId, ...summary }, "confirmation sequence complete");
    return summary;
  },
  {
    connection:      redis,
    concurrency:     2,
    lockDuration:    120_000,  // matches flow-resume — sequential sends can take a while
    stalledInterval: 600_000,
    maxStalledCount: 1,
  },
);

worker.on("failed", (job, err) => {
  log.error({ err, jobId: job?.id, bookingId: job?.data?.bookingId }, "confirmation-sequence job failed");
});

worker.on("error", (err) => {
  log.error({ err }, "confirmation-sequence worker error");
});

export default worker;
