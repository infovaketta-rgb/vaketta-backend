import { Worker } from "bullmq";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { sendTextMessage, sendMediaMessage } from "../services/whatsapp.send.service";
import { MessageStatus } from "@prisma/client";
import { publishMessageStatus } from "../realtime/statusBus";
import "./billing.worker";   // Start billing expiry cron alongside this worker
import "./instagram.worker"; // Start Instagram inbound processor alongside this worker
import { syncPendingTemplates } from "../services/templates.service";
import { logger } from "../utils/logger";

const log = logger.child({ service: "worker" });

log.info("WhatsApp worker booting...");

const worker = new Worker(
  "whatsapp-out",
  async (job) => {
    const { messageId } = job.data;

    // Atomic guard: claim the message by updating status only if still PENDING.
    // If two workers pick up the same job (BullMQ retry / duplicate), only one
    // will succeed here — the other gets count=0 and exits safely.
    const claimed = await prisma.message.updateMany({
      where: { id: messageId, status: MessageStatus.PENDING },
      data:  { status: MessageStatus.SENT }, // placeholder — overwritten below on success/failure
    });

    if (claimed.count === 0) {
      log.warn({ messageId }, "message already claimed by another worker — skipping");
      return;
    }

    // Re-fetch full message after claim
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) return;

    try {
      const isMedia = ["image", "video", "audio", "document"].includes(message.messageType);

      const result = isMedia
        ? await sendMediaMessage({
            toPhone:     message.toPhone,
            hotelId:     message.hotelId,
            messageType: message.messageType,
            mediaUrl:    message.mediaUrl!,
            mimeType:    message.mimeType!,
            fileName:    message.fileName ?? null,
            caption:     message.body    ?? null,
          })
        : await sendTextMessage({
            toPhone:   message.toPhone,
            fromPhone: message.fromPhone,
            text:      message.body!,
            hotelId:   message.hotelId,
            guestId:   message.guestId ?? null,
          });

      // Persist wamid if Meta returned one (null in mock mode)
      const wamid = (result as any)?.messages?.[0]?.id ?? undefined;

      await prisma.message.update({
        where: { id: message.id },
        data:  { status: MessageStatus.SENT, ...(wamid ? { wamid } : {}) },
      });

      publishMessageStatus({ hotelId: message.hotelId, messageId: message.id, status: MessageStatus.SENT });
      log.info({ messageId: message.id, hotelId: message.hotelId }, "message sent");

    } catch (err) {
      await prisma.message.update({
        where: { id: message.id },
        data:  { status: MessageStatus.FAILED },
      });
      publishMessageStatus({ hotelId: message.hotelId, messageId: message.id, status: MessageStatus.FAILED });
      log.error({ err, messageId: message.id, hotelId: message.hotelId }, "message send failed");
      throw err; // re-throw so BullMQ applies retry policy
    }
  },
  {
    connection:     redis,
    concurrency:    2,
    drainDelay:     30_000,  // 30 s idle wait — reduces Upstash commands when queue is empty
    lockDuration:   120_000, // 2-min lock → renewal every ~1 min
    stalledInterval:600_000, // check stalled jobs every 10 min
    maxStalledCount:1,
  }
);

// Persist permanently failed jobs to the dead-letter table so they are
// never silently dropped and can be inspected / replayed by an operator.
worker.on("failed", async (job, err) => {
  log.error({ err, jobId: job?.id, messageId: job?.data?.messageId }, "job exhausted all retries");

  await prisma.deadLetterEvent.create({
    data: {
      provider: "whatsapp",
      payload:  job?.data ?? {},
      error:    String(err),
    },
  }).catch((dbErr) =>
    log.error({ dbErr }, "dead-letter write failed")
  );
});

worker.on("error", (err) => {
  log.error({ err }, "worker error");
});

// Daily cron: sync PENDING templates older than 30 min (runs every 24 h)
const TEMPLATE_SYNC_INTERVAL = 24 * 60 * 60 * 1000;
setInterval(() => {
  syncPendingTemplates().catch((err) => log.error({ err }, "template cron sync failed"));
}, TEMPLATE_SYNC_INTERVAL);
// Also run once at startup (after a brief delay)
setTimeout(() => {
  syncPendingTemplates().catch((err) => log.error({ err }, "template startup sync failed"));
}, 5 * 60 * 1000);
