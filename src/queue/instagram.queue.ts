import { Queue } from "bullmq";
import { redis } from "./redis";

export const instagramQueue = new Queue(
  "instagram-inbound",
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