/**
 * Razorpay webhook worker.
 *
 * Locks in the atomic claim guard — the thing that stops a retry racing a
 * redelivery and processing one payment twice — and the decision to COMPLETE
 * (not retry) a job whose settlement was refused on business grounds.
 *
 * The worker registers itself as an import side effect, so `bullmq`'s Worker is
 * mocked to capture the processor function and invoke it directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, any>;

let webhookEvents: Row[];
let deadLetters: Row[];
let settleCalls: Row[];
let failureCalls: Row[];
let settleResult: any;
let settleThrows: boolean;

/**
 * Captured from `new Worker(name, processor, opts)`.
 *
 * `vi.hoisted` because the worker registers itself as an IMPORT SIDE EFFECT:
 * ESM imports and vi.mock factories both hoist above the module body, so a
 * plain `let` would still be in its temporal dead zone when the constructor
 * runs. The holder object has to exist before any of that.
 */
const captured = vi.hoisted(() => ({
  processor: null as null | ((job: any) => Promise<any>),
  failedHandler: null as null | ((job: any, err: any) => Promise<void>),
}));

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(_name: string, proc: any, _opts: any) {
      captured.processor = proc;
    }
    on(event: string, cb: any) {
      if (event === "failed") captured.failedHandler = cb;
    }
  },
}));

vi.mock("../queue/redis", () => ({ redis: {} }));

vi.mock("../db/connect", () => ({
  default: {
    webhookEvent: {
      updateMany: async ({ where }: any) => {
        const matched = webhookEvents.filter(
          (e) =>
            e.provider === where.provider &&
            e.externalEventId === where.externalEventId &&
            e.processed === where.processed,
        );
        matched.forEach((e) => (e.attempts = (e.attempts ?? 0) + 1));
        return { count: matched.length };
      },
      update: async ({ where, data }: any) => {
        const key = where.provider_externalEventId;
        const row = webhookEvents.find(
          (e) => e.provider === key.provider && e.externalEventId === key.externalEventId,
        )!;
        Object.assign(row, data);
        return row;
      },
    },
    deadLetterEvent: {
      create: async ({ data }: any) => {
        deadLetters.push(data);
        return data;
      },
    },
  },
}));

vi.mock("../services/razorpayPayment.service", () => ({
  settleRazorpayPayment: async (input: any) => {
    settleCalls.push(input);
    if (settleThrows) throw new Error("db down");
    return settleResult;
  },
  recordRazorpayFailure: async (input: any) => {
    failureCalls.push(input);
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import "./razorpay.worker";

const processor = (job: any) => captured.processor!(job);
const failedHandler = (job: any, err: any) => captured.failedHandler!(job, err);

const EVENT_ID = "evt_1";

const job = (over: Row = {}) => ({
  id: EVENT_ID,
  attemptsMade: 0,
  opts: { attempts: 3 },
  data: {
    externalEventId: EVENT_ID,
    event: "payment.captured",
    paymentId: "pay_XYZ",
    orderId: "order_ABC",
    amount: 249900,
    currency: "INR",
    method: "card",
    errorDescription: null,
    ...over,
  },
});

const claimable = () => {
  webhookEvents.push({
    provider: "razorpay",
    externalEventId: EVENT_ID,
    processed: false,
    attempts: 0,
  });
};

beforeEach(() => {
  webhookEvents = [];
  deadLetters = [];
  settleCalls = [];
  failureCalls = [];
  settleThrows = false;
  settleResult = { ok: true, outcome: "settled", invoiceId: "inv_1", paymentId: "pay_XYZ" };
});

describe("razorpay worker", () => {
  it("claims the event, settles the payment, and marks it processed", async () => {
    claimable();
    await processor(job());

    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      orderId: "order_ABC",
      paymentId: "pay_XYZ",
      amount: 249900,
      source: "webhook",
    });
    expect(webhookEvents[0]!.processed).toBe(true);
    expect(webhookEvents[0]!.processedAt).toBeInstanceOf(Date);
  });

  it("SKIPS an event already processed — the claim guard", async () => {
    webhookEvents.push({
      provider: "razorpay",
      externalEventId: EVENT_ID,
      processed: true,
      attempts: 1,
    });

    await processor(job());

    expect(settleCalls).toHaveLength(0);
  });

  it("skips when there is no claim row at all", async () => {
    await processor(job());
    expect(settleCalls).toHaveLength(0);
  });

  it("does not re-process an event once it has COMPLETED", async () => {
    claimable();
    await processor(job());
    expect(settleCalls).toHaveLength(1);

    // A redelivery after completion is refused by the claim guard.
    await processor(job());
    expect(settleCalls).toHaveLength(1);
  });

  it("claim guard is a completed-event guard, NOT a mutual-exclusion lock", async () => {
    // Documents a real property inherited from instagram.worker: the claim only
    // increments `attempts` — it does not flip `processed` — so two genuinely
    // simultaneous runners both pass it. Concurrency is prevented upstream by
    // BullMQ's jobId dedup and job lock, and a double CREDIT is prevented at the
    // money layer by Payment.providerPaymentId @unique (see
    // razorpayPayment.service.test.ts "resolves a TRUE RACE").
    //
    // Asserted rather than fixed so nobody mistakes this guard for a lock.
    claimable();
    await Promise.all([processor(job()), processor(job())]);
    expect(settleCalls).toHaveLength(2);
  });

  it("routes payment.failed to the audit-only failure recorder", async () => {
    claimable();
    await processor(job({ event: "payment.failed", errorDescription: "card declined" }));

    expect(settleCalls).toHaveLength(0);
    expect(failureCalls).toHaveLength(1);
    expect(failureCalls[0]).toMatchObject({
      orderId: "order_ABC",
      paymentId: "pay_XYZ",
      reason: "card declined",
    });
    expect(webhookEvents[0]!.processed).toBe(true);
  });

  it("COMPLETES (does not retry) a settlement refused on business grounds", async () => {
    // An amount mismatch or unknown order cannot be fixed by retrying, and has
    // already been audited — burning the retry budget on it helps nobody.
    claimable();
    settleResult = { ok: false, reason: "amount_mismatch", invoiceId: "inv_1" };

    await expect(processor(job())).resolves.toBeUndefined();
    expect(webhookEvents[0]!.processed).toBe(true);
  });

  it("RETHROWS a transient failure so BullMQ retries it", async () => {
    claimable();
    settleThrows = true;

    await expect(processor(job())).rejects.toThrow(/db down/);
    // Left unprocessed so the retry can claim it again.
    expect(webhookEvents[0]!.processed).toBe(false);
  });

  it("dead-letters ONLY on the final attempt", async () => {
    await failedHandler({ id: EVENT_ID, attemptsMade: 1, opts: { attempts: 3 }, data: {} }, new Error("x"));
    expect(deadLetters).toHaveLength(0);

    await failedHandler({ id: EVENT_ID, attemptsMade: 3, opts: { attempts: 3 }, data: {} }, new Error("x"));
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({ provider: "razorpay" });
  });
});
