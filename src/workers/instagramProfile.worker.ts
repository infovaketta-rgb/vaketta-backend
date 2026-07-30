/**
 * instagramProfile.worker.ts
 *
 * Durable consumer for Instagram guest profile enrichment. The whole job body
 * lives in instagram.profile.service `runInstagramProfileJob` (DB TTL re-check
 * → credential resolve → Graph fetch → avatar mirror → Guest patch); this file
 * only wires it to BullMQ, mirroring instagram.worker.
 *
 * runInstagramProfileJob throws ONLY for retryable failures — permanent Graph
 * conditions (NO_CONSENT / NOT_FOUND / TOKEN_EXPIRED) are recorded on the
 * Guest row and the job completes, so BullMQ never burns retries on them.
 * This worker touches only Guest ig* columns — it can never break message
 * persistence.
 */

import { Worker } from "bullmq";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import { runInstagramProfileJob, type InstagramProfileJobData } from "../services/instagram.profile.service";
import { isFinalAttempt } from "./deadLetter.util";
import { logger } from "../utils/logger";

const log = logger.child({ service: "instagram-profile-worker" });

log.info("instagram-profile worker booting...");

const worker = new Worker<InstagramProfileJobData>(
  "instagram-profile",
  async (job) => {
    await runInstagramProfileJob(job.data);
  },
  {
    connection:      redis,
    concurrency:     2,
    // Upstash free tier (500 k commands/day) — reduce idle Redis pressure:
    drainDelay:      30_000,  // 30 s idle wait — reduces Upstash commands when queue is empty
    lockDuration:    120_000, // 2-min lock → renewal every ~1 min instead of every 15 s
    stalledInterval: 600_000, // check for stalled jobs every 10 min (default: 30 s)
    maxStalledCount: 1,       // stalled job counts as one failure, then falls to retry policy
  },
);

worker.on("failed", async (job, err) => {
  // BullMQ fires "failed" on every attempt — only dead-letter once the
  // final retry is exhausted, otherwise a 3-attempt job writes 3 rows.
  if (!isFinalAttempt(job)) {
    log.warn({ err, jobId: job?.id, attemptsMade: job?.attemptsMade }, "attempt failed — retry scheduled");
    return;
  }

  log.error({ err, jobId: job?.id, guestId: job?.data?.guestId }, "instagram-profile job exhausted retries");

  await prisma.deadLetterEvent.create({
    data: {
      provider: "instagram-profile",
      payload:  job?.data ?? {},
      error:    String(err),
    },
  }).catch((dbErr) => log.error({ dbErr }, "dead-letter write failed"));
});

worker.on("error", (err) => log.error({ err }, "instagram-profile worker error"));

export { worker as instagramProfileWorker };
