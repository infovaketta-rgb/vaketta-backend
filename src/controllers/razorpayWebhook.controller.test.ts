/**
 * Razorpay webhook intake.
 *
 * Locks in the ACK-fast contract: Razorpay retries any non-2xx for 24 hours, so
 * the handler must respond 200 BEFORE doing work, and must never throw after
 * the response is sent.
 *
 * Also pins the idempotency claim (a WebhookEvent row per delivery, P2002 on a
 * redelivery being expected rather than fatal) and the job shape the worker
 * depends on.
 *
 * Signature verification is enforced in the ROUTE, not here — see
 * razorpayWebhook.routes.ts and the signature cases in razorpay.service.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, any>;

let webhookEvents: Row[];
let queued: Row[];
let createThrows: "p2002" | "other" | null;

vi.mock("../db/connect", () => ({
  default: {
    webhookEvent: {
      create: async ({ data }: any) => {
        if (createThrows === "p2002") {
          createThrows = null;
          const err: any = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        if (createThrows === "other") {
          createThrows = null;
          throw new Error("db down");
        }
        webhookEvents.push(data);
        return data;
      },
    },
  },
}));

vi.mock("../queue/razorpay.queue", () => ({
  razorpayQueue: {
    add: async (name: string, data: any, opts: any) => {
      queued.push({ name, data, opts });
      return { id: opts?.jobId };
    },
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { handleRazorpayWebhook } from "./razorpayWebhook.controller";

function mockRes() {
  const res: any = { sendStatus: vi.fn(), status: vi.fn(() => ({ json: vi.fn() })), json: vi.fn() };
  return res;
}

const req = (body: any, headers: Record<string, string> = {}): any => ({
  body,
  get: (h: string) => headers[h.toLowerCase()],
});

const capturedEvent = (over: Row = {}) => ({
  event: "payment.captured",
  payload: {
    payment: {
      entity: {
        id: "pay_XYZ",
        order_id: "order_ABC",
        amount: 249900,
        currency: "INR",
        method: "card",
        ...over,
      },
    },
  },
});

beforeEach(() => {
  webhookEvents = [];
  queued = [];
  createThrows = null;
});

describe("handleRazorpayWebhook", () => {
  it("ACKs with 200 immediately", async () => {
    const res = mockRes();
    await handleRazorpayWebhook(req(capturedEvent()), res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it("stakes an idempotency claim and enqueues the job", async () => {
    const res = mockRes();
    await handleRazorpayWebhook(req(capturedEvent(), { "x-razorpay-event-id": "evt_1" }), res);

    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0]).toMatchObject({
      provider: "razorpay",
      externalEventId: "evt_1",
      processed: false,
    });

    expect(queued).toHaveLength(1);
    expect(queued[0]!.opts.jobId).toBe("evt_1");
    expect(queued[0]!.data).toMatchObject({
      event: "payment.captured",
      paymentId: "pay_XYZ",
      orderId: "order_ABC",
      amount: 249900,
      currency: "INR",
      method: "card",
    });
  });

  it("derives a stable event id when Razorpay sends no delivery header", async () => {
    const res = mockRes();
    await handleRazorpayWebhook(req(capturedEvent()), res);

    // Stable across redeliveries of the same logical event.
    expect(webhookEvents[0]!.externalEventId).toBe("payment.captured:pay_XYZ");
    expect(queued[0]!.opts.jobId).toBe("payment.captured:pay_XYZ");
  });

  it("still enqueues when the claim row already exists (P2002 is expected)", async () => {
    createThrows = "p2002";
    const res = mockRes();

    await handleRazorpayWebhook(req(capturedEvent(), { "x-razorpay-event-id": "evt_1" }), res);

    // The worker's claim guard is what prevents double-processing, so the job
    // must still be enqueued — a redelivery may be a genuine retry of one we
    // never finished.
    expect(queued).toHaveLength(1);
  });

  it("handles payment.failed", async () => {
    const res = mockRes();
    await handleRazorpayWebhook(
      req({
        event: "payment.failed",
        payload: {
          payment: {
            entity: {
              id: "pay_F",
              order_id: "order_ABC",
              amount: 249900,
              currency: "INR",
              error_description: "card declined",
            },
          },
        },
      }),
      res,
    );

    expect(queued).toHaveLength(1);
    expect(queued[0]!.data).toMatchObject({
      event: "payment.failed",
      paymentId: "pay_F",
      errorDescription: "card declined",
    });
  });

  it("IGNORES out-of-scope events but still ACKs them", async () => {
    for (const event of [
      "subscription.charged",
      "refund.created",
      "order.paid",
      "settlement.processed",
    ]) {
      queued = [];
      webhookEvents = [];
      const res = mockRes();
      await handleRazorpayWebhook(req({ event, payload: {} }), res);

      expect(res.sendStatus).toHaveBeenCalledWith(200);
      expect(queued).toHaveLength(0);
      expect(webhookEvents).toHaveLength(0);
    }
  });

  it("ignores a handled event missing its payment or order id", async () => {
    const res = mockRes();
    await handleRazorpayWebhook(
      req({ event: "payment.captured", payload: { payment: { entity: { id: "pay_X" } } } }),
      res,
    );

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(queued).toHaveLength(0);
  });

  it("NEVER throws after the ACK, even when the database is down", async () => {
    createThrows = "other";
    const res = mockRes();

    await expect(handleRazorpayWebhook(req(capturedEvent()), res)).resolves.toBeUndefined();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(queued).toHaveLength(0);
  });

  it("tolerates a completely malformed body", async () => {
    const res = mockRes();
    await expect(handleRazorpayWebhook(req({}), res)).resolves.toBeUndefined();
    await expect(handleRazorpayWebhook(req(null), res)).resolves.toBeUndefined();
    expect(queued).toHaveLength(0);
  });
});
