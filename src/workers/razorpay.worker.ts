/**
 * workers/razorpay.worker.ts
 *
 * Consumes verified Razorpay webhook events and applies them to invoices.
 *
 * Structure copied from `instagram.worker.ts` deliberately — the atomic
 * `WebhookEvent.updateMany({ where: { processed: false } })` claim is what stops
 * two workers (or a retry racing a redelivery) from processing one event twice.
 *
 * Settlement itself routes through `settleRazorpayPayment`, the same function
 * the checkout callback uses, so a payment confirmed here is credited
 * identically to one confirmed in the browser.
 */
import { Worker } from "bullmq";
import prisma from "../db/connect";
import { redis } from "../queue/redis";
import {
  settleRazorpayPayment,
  recordRazorpayFailure,
} from "../services/razorpayPayment.service";
import { isFinalAttempt } from "./deadLetter.util";
import { logger } from "../utils/logger";

const log = logger.child({ service: "razorpay-worker" });

log.info("Razorpay worker booting...");

const worker = new Worker(
  "razorpay-webhook",

  async (job) => {
    const { externalEventId, event, paymentId, orderId, amount, currency, method, errorDescription } =
      job.data as {
        externalEventId: string;
        event: string;
        paymentId: string;
        orderId: string;
        amount: number;
        currency: string;
        method: string | null;
        errorDescription: string | null;
      };

    // Atomic claim — only one runner may process this event.
    const claimed = await prisma.webhookEvent.updateMany({
      where: { provider: "razorpay", externalEventId, processed: false },
      data: { attempts: { increment: 1 } },
    });

    if (claimed.count === 0) {
      log.warn({ externalEventId }, "razorpay event already claimed, skipping");
      return;
    }

    try {
      if (event === "payment.captured") {
        const result = await settleRazorpayPayment({
          orderId,
          paymentId,
          amount,
          currency,
          source: "webhook",
          method,
        });

        if (!result.ok) {
          // A refusal is a FINAL business decision (unknown order, wrong amount,
          // voided invoice), not a transient fault — retrying cannot change it,
          // and it has already been logged and audited. Complete the job so the
          // retry budget is not burned on an impossible outcome.
          log.warn({ externalEventId, paymentId, reason: result.reason }, "razorpay settlement refused");
        }
      } else if (event === "payment.failed") {
        await recordRazorpayFailure({
          orderId,
          paymentId,
          reason: errorDescription,
          method,
        });
      }

      await prisma.webhookEvent.update({
        where: { provider_externalEventId: { provider: "razorpay", externalEventId } },
        data: { processed: true, processedAt: new Date() },
      });

      log.info({ externalEventId, event, paymentId }, "razorpay event processed");
    } catch (err) {
      log.error({ err, externalEventId, paymentId }, "razorpay job failed");
      throw err;
    }
  },
  {
    connection: redis,
    concurrency: 2,
    // Same Upstash-conscious tuning as the other workers — see queue/redis.ts.
    drainDelay: 30_000,
    lockDuration: 120_000,
    stalledInterval: 600_000,
    maxStalledCount: 1,
  },
);

worker.on("failed", async (job, err) => {
  // BullMQ fires "failed" on every attempt — dead-letter only once retries are
  // exhausted, or a 3-attempt job writes 3 rows.
  if (!isFinalAttempt(job)) {
    log.warn({ err, jobId: job?.id, attemptsMade: job?.attemptsMade }, "attempt failed — retry scheduled");
    return;
  }

  log.error({ err, jobId: job?.id }, "razorpay job exhausted retries");

  await prisma.deadLetterEvent.create({
    data: { provider: "razorpay", payload: job?.data ?? {}, error: String(err) },
  });
});

worker.on("error", (err) => {
  log.error({ err }, "razorpay worker error");
});
