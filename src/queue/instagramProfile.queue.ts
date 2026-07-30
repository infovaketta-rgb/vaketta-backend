import { Queue } from "bullmq";
import { redis } from "./redis";

// Durable queue for Instagram guest profile enrichment. Producer:
// instagram.profile.service (time-bucketed jobId collapses message bursts into
// one job; the staff refresh endpoint enqueues with force:true). Consumer:
// instagramProfile.worker → runInstagramProfileJob. Option values mirror
// instagram.queue.ts.
export const instagramProfileQueue = new Queue(
  "instagram-profile",
  {
    connection: redis,
    defaultJobOptions:{
      attempts: 3,           // 3 total attempts — reduces retry-loop Redis commands
      backoff:{
        type: "exponential",
        delay: 10_000,       // 10 s → 20 s → 40 s — space retries out more
      },
      removeOnComplete:{ count: 100 },
      removeOnFail:    { count: 50  },
    }
  }
);
