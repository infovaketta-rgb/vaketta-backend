import { Queue } from "bullmq";
import { redis } from "./redis";

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
