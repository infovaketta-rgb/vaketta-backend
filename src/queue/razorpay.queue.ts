import { Queue } from "bullmq";
import { redis } from "./redis";

/**
 * Razorpay webhook processing queue.
 *
 * Options mirror `instagram.queue.ts` — the same retry budget and retention
 * policy, for the same reason: a transient database blip should be retried a
 * few times with backoff, then dead-lettered rather than retried forever.
 *
 * Settlement is idempotent end to end (`Payment.providerPaymentId @unique` plus
 * the claim guard in the worker), so a retry can never double-credit an
 * invoice — which is what makes an automatic retry policy safe here at all.
 */
export const razorpayQueue = new Queue("razorpay-webhook", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});
