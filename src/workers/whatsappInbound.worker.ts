/**
 * whatsappInbound.worker.ts
 *
 * Durable consumer for inbound WhatsApp messages. The webhook controller ACKs
 * Meta and enqueues the message here, instead of running the bot pipeline as a
 * dangling in-process promise. This gives us:
 *   • durability   — a crash/restart re-runs the queued job (Redis-backed)
 *                    instead of silently dropping the guest's message
 *   • backpressure — `concurrency` caps simultaneous bot/AI pipelines so a burst
 *                    of inbound messages can't exhaust memory or the DB pool
 *
 * IMPORTANT: this worker MUST run in the WEB process — it is started via
 * bootstrap/workers.ts (imported by server.ts). logIncomingMessage emits
 * Socket.IO events via emitToHotel, and `io` only has connected clients in the
 * web process (there is no Socket.IO Redis adapter). Running it in a separate
 * worker process would silently drop message:new / staff:notification /
 * message:media_ready realtime updates. All workers now run in this one process.
 */

import { Worker } from "bullmq";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";
import { logIncomingMessage, IncomingMessageInput } from "../services/message.service";
import { downloadMetaMedia } from "../services/media.service";
import { emitToHotel } from "../realtime/emit";

const log = logger.child({ service: "whatsapp-inbound-worker" });

type MediaInfo = { mediaId: string; mimeType: string; fileName: string | null };

type InboundJob = {
  input: IncomingMessageInput;
  media: MediaInfo | null;
};

log.info("WhatsApp inbound worker booting...");

const worker = new Worker<InboundJob>(
  "whatsapp-inbound",
  async (job) => {
    const { input, media } = job.data;

    // logIncomingMessage dedups by wamid, so a retry / Meta re-delivery is safe.
    await logIncomingMessage(input);

    // Media messages: logIncomingMessage saved a `pending://` bubble; now fetch
    // the file from Meta, store it in R2, and swap in the real URL.
    if (media) {
      await downloadAndStoreMedia(media, input.toPhone);
    }
  },
  {
    connection:      redis,
    // Bounded concurrency — the cap that finding #3 was about. Tunable per-dyno.
    concurrency:     Number(process.env.WHATSAPP_INBOUND_CONCURRENCY) || 5,
    drainDelay:      30_000,  // 30s idle wait — reduces Upstash commands when empty
    lockDuration:    120_000, // 2-min lock → renewal every ~1 min
    stalledInterval: 600_000, // check stalled jobs every 10 min
    maxStalledCount: 1,
  },
);

async function downloadAndStoreMedia(media: MediaInfo, toPhone: string): Promise<void> {
  const hotel = await prisma.hotel.findUnique({
    where:   { phone: toPhone },
    include: { config: true },
  });
  if (!hotel) return;

  const message = await prisma.message.findFirst({
    where:   { mediaUrl: `pending://${media.mediaId}`, hotelId: hotel.id },
    orderBy: { timestamp: "desc" },
  });
  if (!message) return;

  const downloaded = await downloadMetaMedia(media.mediaId, media.mimeType, toPhone);
  if (!downloaded) return;

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: {
      mediaUrl: downloaded.localUrl,
      mimeType: downloaded.mimeType,
      fileName: downloaded.fileName,
    },
  });

  emitToHotel(hotel.id, "message:media_ready", {
    messageId: updated.id,
    mediaUrl:  downloaded.localUrl,
    mimeType:  downloaded.mimeType,
    fileName:  downloaded.fileName,
  });
}

// Persist permanently failed jobs to the dead-letter table for inspection/replay.
worker.on("failed", async (job, err) => {
  log.error({ err, jobId: job?.id, wamid: job?.data?.input?.wamid }, "inbound job exhausted all retries");
  await prisma.deadLetterEvent.create({
    data: {
      provider: "whatsapp-inbound",
      payload:  job?.data ?? {},
      error:    String(err),
    },
  }).catch((dbErr) => log.error({ dbErr }, "dead-letter write failed"));
});

worker.on("error", (err) => log.error({ err }, "whatsapp inbound worker error"));

export { worker as whatsappInboundWorker };
