import { Queue } from "bullmq";
import { redis } from "./redis";

export const whatsappQueue = new Queue("whatsapp-out", {
  connection: redis,
  defaultJobOptions: {
    attempts:    4,                              // initial attempt + 3 retries
    backoff: {
      type:  "exponential",
      delay: 2_000,                             // 2s → 4s → 8s → 16s
    },
    removeOnComplete: { count: 500 },           // keep last 500 completed jobs
    removeOnFail:     { count: 200 },           // keep last 200 failed jobs for inspection
  },
});
