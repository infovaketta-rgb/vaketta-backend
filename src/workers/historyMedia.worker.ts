/**
 * historyMedia.worker.ts
 *
 * Durable consumer for backfilling media on historical WhatsApp Coexistence
 * sync messages. history.service writes a `pending://{mediaId}` bubble for
 * every media message in a history chunk (so bulk import never blocks on
 * network I/O), then enqueues one job per message here.
 *
 * Reuses the SAME downloadMetaMedia() pipeline as live inbound media (Graph
 * API fetch → R2 upload) — no duplicated download/upload logic.
 *
 * Unlike whatsappInbound.worker's downloadAndStoreMedia (which finds the
 * target row via `mediaUrl: pending://{mediaId}` + "most recent"), this job
 * targets the row by `messageId` directly. A bulk history import can enqueue
 * many pending media rows for the same hotel within milliseconds of each
 * other, so a content-based "most recent" lookup would race and patch the
 * wrong row; jobId = messageId sidesteps that entirely.
 *
 * IMPORTANT: historical media backfill stays SILENT, same as the rest of
 * history import — no message:media_ready emit. Runs in the WEB process for
 * consistency with the other workers (see whatsappInbound.worker.ts header),
 * though it does not itself use Socket.IO.
 */

import { Worker } from "bullmq";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";
import { downloadMetaMedia } from "../services/media.service";

const log = logger.child({ service: "history-media-worker" });

type HistoryMediaJob = {
  messageId: string;
  mediaId:   string;
  mimeType:  string;
  hotelPhone: string; // normalized hotel phone — resolves the per-hotel access token
};

log.info("history-media worker booting...");

const worker = new Worker<HistoryMediaJob>(
  "history-media",
  async (job) => {
    const { messageId, mediaId, mimeType, hotelPhone } = job.data;

    // Idempotent: if a previous attempt already resolved this row (or the
    // row was since deleted), there is nothing left to do.
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.mediaUrl !== `pending://${mediaId}`) return;

    const downloaded = await downloadMetaMedia(mediaId, mimeType, hotelPhone);
    if (!downloaded) return; // downloadMetaMedia already logs the reason; row stays pending for retry

    await prisma.message.update({
      where: { id: messageId },
      data: {
        mediaUrl: downloaded.localUrl,
        mimeType: downloaded.mimeType,
        fileName: downloaded.fileName,
      },
    });
    // No emitToHotel — historical backfill is silent by design.
  },
  {
    connection:      redis,
    concurrency:     Number(process.env.HISTORY_MEDIA_CONCURRENCY) || 5,
    drainDelay:      30_000,
    lockDuration:    120_000,
    stalledInterval: 600_000,
    maxStalledCount: 1,
  },
);

// Persist permanently failed jobs to the dead-letter table for inspection/replay.
worker.on("failed", async (job, err) => {
  log.error({ err, jobId: job?.id, messageId: job?.data?.messageId }, "history-media job exhausted all retries");
  await prisma.deadLetterEvent.create({
    data: {
      provider: "history-media",
      payload:  job?.data ?? {},
      error:    String(err),
    },
  }).catch((dbErr) => log.error({ dbErr }, "dead-letter write failed"));
});

worker.on("error", (err) => log.error({ err }, "history-media worker error"));

export { worker as historyMediaWorker };
