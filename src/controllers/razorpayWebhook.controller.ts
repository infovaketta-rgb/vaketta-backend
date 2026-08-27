/**
 * controllers/razorpayWebhook.controller.ts
 *
 * Receives Razorpay webhooks. ACK FAST, PROCESS LATER - the same shape as the
 * Instagram webhook: verify the signature, stake an idempotency claim, enqueue,
 * and return 200 immediately. Razorpay retries a non-2xx for up to 24 hours, so
 * doing settlement work inline would turn one slow database write into a storm
 * of duplicate deliveries.
 *
 * THE WEBHOOK IS THE AUTHORITY. The checkout callback is best-effort (the user
 * may close the tab); this path is what guarantees a captured payment is always
 * eventually credited. Both converge on `settleRazorpayPayment`.
 *
 * Signature verification runs in the ROUTE, before this handler, on the raw
 * body buffer - see razorpayWebhook.routes.ts.
 */
import { Request, Response } from "express";
import crypto from "crypto";
import prisma from "../db/connect";
import { razorpayQueue } from "../queue/razorpay.queue";
import { logger } from "../utils/logger";

const log = logger.child({ service: "razorpay-webhook" });

/** Events Stage 2B acts on. Everything else is acknowledged and ignored. */
const HANDLED_EVENTS = new Set(["payment.captured", "payment.failed"]);

export async function handleRazorpayWebhook(req: Request, res: Response) {
  // ACK before any work. A 200 here means "received", never "settled".
  res.sendStatus(200);

  try {
    const body = req.body as any;
    const event = String(body?.event ?? "");

    if (!HANDLED_EVENTS.has(event)) {
      // Subscriptions, refunds, settlements, order.paid - deliberately out of
      // scope for this stage. Acknowledged so Razorpay stops retrying.
      log.debug({ event }, "razorpay event ignored (out of scope for this stage)");
      return;
    }

    const entity = body?.payload?.payment?.entity;
    const paymentId: string | undefined = entity?.id;
    const orderId: string | undefined = entity?.order_id;

    if (!paymentId || !orderId) {
      log.warn({ event }, "razorpay webhook missing payment or order id - ignoring");
      return;
    }

    // Razorpay's own delivery id when present; otherwise derive a stable key so
    // a redelivery of the same event still collapses onto one row.
    const headerEventId = req.get("x-razorpay-event-id");
    const externalEventId = headerEventId
      ? `${headerEventId}`
      : `${event}:${paymentId}`;

    // Pre-create the idempotency record so the worker's claim guard has a row
    // to claim. A redelivery throws P2002 here, which is expected and safe -
    // exactly the pattern instagram.controller.ts uses.
    try {
      await prisma.webhookEvent.create({
        data: {
          provider: "razorpay",
          externalEventId,
          payloadHash: crypto.createHash("sha256").update(externalEventId).digest("hex"),
          processed: false,
        },
      });
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
      log.info({ externalEventId }, "razorpay webhook already seen - relying on claim guard");
    }

    await razorpayQueue.add(
      "razorpay-webhook",
      {
        externalEventId,
        event,
        paymentId,
        orderId,
        amount: typeof entity.amount === "number" ? entity.amount : Number(entity.amount),
        currency: String(entity.currency ?? ""),
        method: entity.method ? String(entity.method) : null,
        // Razorpay's own decline description. Safe to store: it is a reason
        // string ("card declined"), never card data.
        errorDescription: entity.error_description ? String(entity.error_description) : null,
      },
      { jobId: externalEventId },
    );

    log.info({ event, paymentId, externalEventId }, "razorpay webhook queued");
  } catch (err) {
    // Never rethrow: the response is already sent, and an exception here would
    // only produce an unhandled rejection.
    log.error({ err }, "razorpay webhook intake failed");
  }
}
