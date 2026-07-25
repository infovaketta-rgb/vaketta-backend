import { Queue } from "bullmq";
import { redis } from "./redis";

// Durable queue for backfilling media on historical WhatsApp Coexistence sync
// messages. Producer: history.service `processThread` (jobId = message.id, so
// retries/re-delivery target the exact row instead of a content-based lookup —
// bulk import can have many pending media rows in flight at once, unlike the
// live whatsapp-inbound queue which only ever has one pending row per mediaId).
// Consumer: historyMedia.worker — reuses downloadMetaMedia (same Graph API + R2
// pipeline as live inbound), no realtime emit (historical import stays silent).
export const historyMediaQueue = new Queue("history-media", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type:  "exponential",
      delay: 10_000, // 10s → 20s → 40s
    },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50  },
  },
});
