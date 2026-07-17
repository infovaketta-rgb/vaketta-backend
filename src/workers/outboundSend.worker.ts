/**
 * outboundSend.worker.ts
 *
 * Consumer for the `whatsapp-out` queue — durable delayed outbound sends.
 *
 * Producer: message.service `sendManualReply` enqueues a delayed job (jobId =
 * message.id) when a hotel has messageDelayEnabled. The old implementation used
 * an in-process setTimeout that was lost on restart; this queue makes the send
 * durable and channel-aware (WhatsApp AND Instagram) via executeDelayedSend().
 *
 * Runs in the WEB process: executeDelayedSend emits Socket.IO events
 * (message:status) via emitToHotel, and `io` only has connected clients in the
 * web process (no Socket.IO Redis adapter). See whatsappInbound.worker.ts header.
 */
import { Worker } from "bullmq";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";
import { executeDelayedSend } from "../services/message.service";

const log = logger.child({ service: "outbound-send-worker" });

log.info("outbound-send worker booting...");

const worker = new Worker(
  "whatsapp-out",
  async (job) => {
    const { messageId } = job.data as { messageId: string };
    await executeDelayedSend(messageId);
  },
  {
    connection:      redis,
    concurrency:     2,
    drainDelay:      30_000,  // 30s idle wait — self-hosted Redis can lower this; see queue/redis.ts
    lockDuration:    120_000, // 2-min lock → renewal every ~1 min
    stalledInterval: 600_000, // check stalled jobs every 10 min
    maxStalledCount: 1,
  },
);

// Persist permanently failed jobs to the dead-letter table for inspection/replay.
worker.on("failed", async (job, err) => {
  log.error({ err, jobId: job?.id, messageId: job?.data?.messageId }, "outbound-send job exhausted retries");
  await prisma.deadLetterEvent.create({
    data: {
      provider: "whatsapp-out",
      payload:  job?.data ?? {},
      error:    String(err),
    },
  }).catch((dbErr) => log.error({ dbErr }, "dead-letter write failed"));
});

worker.on("error", (err) => log.error({ err }, "outbound-send worker error"));

export { worker as outboundSendWorker };
