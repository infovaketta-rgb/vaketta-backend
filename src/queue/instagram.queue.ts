import { Queue } from "bullmq";
import { redis } from "./redis";

export const instagramQueue = new Queue(
  "instagram-inbound",
  {
    connection: redis,
    defaultJobOptions:{
      attempts:5,
      backoff:{
        type:"exponential",
        delay:2000
      },
      removeOnComplete:{count:500},
      removeOnFail:{count:200}
    }
  }
);