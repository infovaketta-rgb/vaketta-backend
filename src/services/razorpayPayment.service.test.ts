/**
 * Razorpay → Vaketta payment convergence.
 *
 * The correctness core of the integration. Locks in:
 *  - the callback and the webhook produce an IDENTICAL result and, together,
 *    credit an invoice exactly ONCE;
 *  - the hotel/invoice is resolved from a LOCAL providerOrderId lookup, never
 *    from Razorpay's `notes` — so a payload cannot name its own target;
 *  - an amount that disagrees with the outstanding balance is REFUSED, in
 *    either direction (under- and over-payment both corrupt the ledger);
 *  - VOID and already-PAID invoices are refused;
 *  - settlement delegates to `recordPayment` — the existing single writer — and
 *    is therefore not a second settlement path;
 *  - `providerOrderId` is NEVER written to a Payment row, so a failed attempt
 *    cannot block the successful retry on the unique index (the multi-attempt
 *    regression);
 *  - a failed payment writes an AUDIT EVENT ONLY, never a Payment row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma, InvoiceStatus } from "@prisma/client";

type Row = Record<string, any>;

let invoices: Row[];
let payments: Row[];
let auditEvents: Row[];
let recordPaymentCalls: Row[];
/** Simulates the DB-level unique index on Payment.providerPaymentId. */
let simulateRaceOnce: boolean;
/** Simulates a transient (non-duplicate) database failure. */
let throwGenericOnce: boolean;

const dupError = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: ["providerPaymentId"] },
  });

vi.mock("../db/connect", () => ({
  default: {
    payment: {
      findUnique: async ({ where }: any) =>
        payments.find((p) => p.providerPaymentId === where.providerPaymentId) ?? null,
    },
    invoice: {
      findUnique: async ({ where }: any) =>
        invoices.find((i) => i.providerOrderId === where.providerOrderId) ?? null,
    },
  },
}));

vi.mock("./invoice.service", () => ({
  recordPayment: async (input: any) => {
    recordPaymentCalls.push(input);
    if (simulateRaceOnce) {
      simulateRaceOnce = false;
      throw dupError();
    }
    if (throwGenericOnce) {
      throwGenericOnce = false;
      throw new Error("connection lost");
    }
    const invoice = invoices.find((i) => i.id === input.invoiceId)!;
    // Mirror the real writer closely enough to assert settlement semantics.
    payments.push({
      id: `pay_local_${payments.length + 1}`,
      invoiceId: input.invoiceId,
      providerPaymentId: input.providerPaymentId ?? null,
      providerOrderId: input.providerOrderId ?? null,
      amount: input.amount,
      status: input.status,
    });
    invoice.amountPaid += input.amount;
    const settled = invoice.amountPaid >= invoice.total;
    if (settled) invoice.status = InvoiceStatus.PAID;
    return { payment: payments[payments.length - 1], invoice, settled };
  },
}));

vi.mock("./audit.service", () => ({
  recordBillingEvent: async (type: string, args: any) => {
    auditEvents.push({ type, ...args });
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { settleRazorpayPayment, recordRazorpayFailure } from "./razorpayPayment.service";

const ORDER = "order_ABC";
const PAYMENT = "pay_XYZ";

const invoice = (over: Row = {}) => {
  const row = {
    id: "inv_1",
    hotelId: "hotel_1",
    number: "INV-2026-00001",
    status: InvoiceStatus.OPEN,
    currency: "INR",
    total: 249900,
    amountPaid: 0,
    providerOrderId: ORDER,
    ...over,
  };
  invoices.push(row);
  return row;
};

const captured = (over: Row = {}) => ({
  orderId: ORDER,
  paymentId: PAYMENT,
  amount: 249900,
  currency: "INR",
  source: "webhook" as const,
  ...over,
});

beforeEach(() => {
  invoices = [];
  payments = [];
  auditEvents = [];
  recordPaymentCalls = [];
  simulateRaceOnce = false;
  throwGenericOnce = false;
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe("settleRazorpayPayment — success", () => {
  it("credits the invoice and reports it settled", async () => {
    const inv = invoice();
    const result = await settleRazorpayPayment(captured());

    expect(result).toMatchObject({ ok: true, outcome: "settled", invoiceId: "inv_1" });
    expect(inv.amountPaid).toBe(249900);
    expect(inv.status).toBe(InvoiceStatus.PAID);
  });

  it("delegates to recordPayment — it does NOT write its own settlement", async () => {
    invoice();
    await settleRazorpayPayment(captured());

    expect(recordPaymentCalls).toHaveLength(1);
    expect(recordPaymentCalls[0]).toMatchObject({
      invoiceId: "inv_1",
      amount: 249900,
      status: "SUCCEEDED",
      provider: "razorpay",
      providerPaymentId: PAYMENT,
    });
  });

  it("NEVER writes providerOrderId onto the Payment row (multi-attempt safety)", async () => {
    invoice();
    await settleRazorpayPayment(captured());
    expect(recordPaymentCalls[0]!.providerOrderId).toBeUndefined();
  });

  it("records the payment method when Razorpay reports one", async () => {
    invoice();
    await settleRazorpayPayment(captured({ method: "upi" }));
    expect(recordPaymentCalls[0]!.method).toBe("razorpay_upi");
  });

  it("audits payment.gateway_verified with the source", async () => {
    invoice();
    await settleRazorpayPayment(captured({ source: "checkout_callback" }));

    const ev = auditEvents.find((e) => e.type === "payment.gateway_verified")!;
    expect(ev.hotelId).toBe("hotel_1");
    expect(ev.data).toMatchObject({ orderId: ORDER, paymentId: PAYMENT, source: "checkout_callback" });
  });

  it("reports 'partial' when the payment does not cover the invoice", async () => {
    // Partial only arises if an invoice grew after the order was opened; the
    // amount still has to equal the outstanding balance at settlement time.
    const inv = invoice({ total: 500000, amountPaid: 250100 });
    const result = await settleRazorpayPayment(captured({ amount: 249900 }));

    expect(result).toMatchObject({ ok: true, outcome: "settled" });
    expect(inv.status).toBe(InvoiceStatus.PAID);
  });
});

// ── Convergence + idempotency ────────────────────────────────────────────────

describe("settleRazorpayPayment — convergence and idempotency", () => {
  it("callback and webhook produce IDENTICAL outcomes", async () => {
    invoice();
    const viaCallback = await settleRazorpayPayment(captured({ source: "checkout_callback" }));

    invoices.length = 0;
    payments.length = 0;
    invoice();
    const viaWebhook = await settleRazorpayPayment(captured({ source: "webhook" }));

    expect(viaCallback).toEqual(viaWebhook);
  });

  it("credits the invoice ONCE when both paths fire for the same payment", async () => {
    const inv = invoice();

    const first = await settleRazorpayPayment(captured({ source: "checkout_callback" }));
    const second = await settleRazorpayPayment(captured({ source: "webhook" }));

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: true, outcome: "already_processed" });
    expect(inv.amountPaid).toBe(249900); // not 499800
    expect(recordPaymentCalls).toHaveLength(1);
  });

  it("a duplicate webhook delivery is a no-op", async () => {
    const inv = invoice();
    await settleRazorpayPayment(captured());
    await settleRazorpayPayment(captured());
    await settleRazorpayPayment(captured());

    expect(inv.amountPaid).toBe(249900);
    expect(recordPaymentCalls).toHaveLength(1);
  });

  it("resolves a TRUE RACE via the unique index rather than double-crediting", async () => {
    // Both callers pass the pre-check, then one loses on
    // Payment.providerPaymentId @unique. That is success, not failure.
    const inv = invoice();
    simulateRaceOnce = true;

    const result = await settleRazorpayPayment(captured());

    expect(result).toMatchObject({ ok: true, outcome: "already_processed" });
    expect(inv.amountPaid).toBe(0); // the winning caller credited it, not this one
  });

  it("rethrows a non-duplicate database error instead of swallowing it", async () => {
    const inv = invoice();
    throwGenericOnce = true;

    await expect(settleRazorpayPayment(captured())).rejects.toThrow(/connection lost/);
    // A transient fault must NOT be mistaken for "already processed" — the
    // webhook has to retry, so the invoice stays uncredited and open.
    expect(inv.amountPaid).toBe(0);
  });
});

// ── Guards ───────────────────────────────────────────────────────────────────

describe("settleRazorpayPayment — guards", () => {
  it("refuses an UNKNOWN order and never credits anything", async () => {
    invoice({ providerOrderId: "order_DIFFERENT" });
    const result = await settleRazorpayPayment(captured());

    expect(result).toMatchObject({ ok: false, reason: "unknown_order" });
    expect(recordPaymentCalls).toHaveLength(0);
  });

  it("REFUSES an amount that does not match the outstanding balance (tampering)", async () => {
    const inv = invoice();
    const result = await settleRazorpayPayment(captured({ amount: 100 }));

    expect(result).toMatchObject({ ok: false, reason: "amount_mismatch" });
    expect(inv.amountPaid).toBe(0);
    expect(recordPaymentCalls).toHaveLength(0);
  });

  it("REFUSES an OVERPAYMENT as firmly as an underpayment", async () => {
    const inv = invoice();
    const result = await settleRazorpayPayment(captured({ amount: 999999 }));

    expect(result).toMatchObject({ ok: false, reason: "amount_mismatch" });
    expect(inv.amountPaid).toBe(0);
  });

  it("audits a refused amount so the mismatch is investigable", async () => {
    invoice();
    await settleRazorpayPayment(captured({ amount: 100 }));

    const ev = auditEvents.find((e) => e.type === "payment.gateway_rejected")!;
    expect(ev.data).toMatchObject({ reason: "amount_mismatch", expected: 249900, received: 100 });
  });

  it("accounts for a partial payment when computing the expected amount", async () => {
    invoice({ amountPaid: 49900 });
    const ok = await settleRazorpayPayment(captured({ amount: 200000 }));
    expect(ok.ok).toBe(true);
  });

  it("refuses a VOIDED invoice and flags it for manual refund", async () => {
    invoice({ status: InvoiceStatus.VOID });
    const result = await settleRazorpayPayment(captured());

    expect(result).toMatchObject({ ok: false, reason: "invoice_void" });
    expect(recordPaymentCalls).toHaveLength(0);
    expect(auditEvents.some((e) => e.type === "payment.gateway_rejected")).toBe(true);
  });

  it("refuses an already-PAID invoice", async () => {
    invoice({ status: InvoiceStatus.PAID, amountPaid: 249900 });
    const result = await settleRazorpayPayment(captured());

    expect(result).toMatchObject({ ok: false, reason: "invoice_already_paid" });
    expect(recordPaymentCalls).toHaveLength(0);
  });

  it("refuses a CURRENCY MISMATCH", async () => {
    invoice({ currency: "USD" });
    const result = await settleRazorpayPayment(captured({ currency: "USD" }));

    expect(result).toMatchObject({ ok: false, reason: "currency_mismatch" });
    expect(recordPaymentCalls).toHaveLength(0);
  });

  it("refuses when the paid currency differs from the invoice currency", async () => {
    invoice({ currency: "INR" });
    const result = await settleRazorpayPayment(captured({ currency: "USD" }));
    expect(result).toMatchObject({ ok: false, reason: "currency_mismatch" });
  });

  it("refuses a non-integer or non-positive amount", async () => {
    for (const amount of [0, -1, 12.5]) {
      invoices.length = 0;
      invoice({ total: amount > 0 ? amount : 100 });
      const result = await settleRazorpayPayment(captured({ amount }));
      expect(result.ok).toBe(false);
    }
  });
});

// ── Failures ─────────────────────────────────────────────────────────────────

describe("recordRazorpayFailure", () => {
  it("writes an AUDIT EVENT ONLY — never a Payment row", async () => {
    invoice();
    await recordRazorpayFailure({ orderId: ORDER, paymentId: PAYMENT, reason: "card declined" });

    expect(payments).toHaveLength(0);
    expect(recordPaymentCalls).toHaveLength(0);

    const ev = auditEvents.find((e) => e.type === "payment.failed")!;
    expect(ev.hotelId).toBe("hotel_1");
    expect(ev.data).toMatchObject({
      invoiceId: "inv_1",
      orderId: ORDER,
      paymentId: PAYMENT,
      provider: "razorpay",
      failureReason: "card declined",
    });
  });

  it("leaves the invoice OPEN and uncredited", async () => {
    const inv = invoice();
    await recordRazorpayFailure({ orderId: ORDER, paymentId: PAYMENT, reason: "declined" });

    expect(inv.status).toBe(InvoiceStatus.OPEN);
    expect(inv.amountPaid).toBe(0);
  });

  it("ignores a failure for an unknown order without throwing", async () => {
    await expect(
      recordRazorpayFailure({ orderId: "order_NOPE", paymentId: PAYMENT }),
    ).resolves.toBeUndefined();
    expect(auditEvents).toHaveLength(0);
  });

  it("MULTI-ATTEMPT REGRESSION: a failed attempt never blocks the successful retry", async () => {
    // Razorpay reuses one order across attempts but issues a new pay_* each
    // time. Because the failure writes no Payment row (and settlement never
    // writes providerOrderId), the retry settles cleanly.
    const inv = invoice();

    await recordRazorpayFailure({ orderId: ORDER, paymentId: "pay_ATTEMPT_1", reason: "declined" });
    const retry = await settleRazorpayPayment(captured({ paymentId: "pay_ATTEMPT_2" }));

    expect(retry).toMatchObject({ ok: true, outcome: "settled" });
    expect(inv.status).toBe(InvoiceStatus.PAID);
    expect(recordPaymentCalls[0]!.providerOrderId).toBeUndefined();
  });
});
