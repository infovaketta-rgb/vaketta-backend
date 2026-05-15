import { Queue } from "bullmq";
import { redis } from "./redis";

export const flowResumeQueue = new Queue("flow-resume", {
  connection: redis,
  defaultJobOptions: {
    attempts:         1,   // no retries — double-fire would re-run flow nodes
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50  },
  },
});
