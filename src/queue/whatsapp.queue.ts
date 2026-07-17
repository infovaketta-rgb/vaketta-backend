import { Queue } from "bullmq";
import { redis } from "./redis";

// Durable delayed outbound sends. Producer: message.service `sendManualReply`
// (delayed staff replies, jobId = message.id). Consumer: outboundSend.worker.
// Retries are idempotent — executeDelayedSend atomically claims the PENDING row,
// so a retry after the row is SENT/FAILED/deleted no-ops instead of double-sending.
export const whatsappQueue = new Queue("whatsapp-out", {
  connection: redis,
  defaultJobOptions: {
    attempts:    3,                              // 3 total attempts
    backoff: {
      type:  "exponential",
      delay: 10_000,                            // 10s → 20s → 40s
    },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50  },
  },
});
