/**
 * Razorpay tenant-facing endpoints.
 *
 * Locks in the authorization and trust boundary:
 *  - IDOR: hotel A cannot open an order against, or settle, hotel B's invoice —
 *    and gets a 404 rather than a 403, so invoice ids cannot be enumerated;
 *  - the amount is ALWAYS derived from the invoice, never read from the body,
 *    so a tampered request cannot under- or over-pay;
 *  - a valid signature proves Razorpay saw a payment, NOT that the caller owns
 *    the invoice — ownership is checked separately on the verify path;
 *  - non-INR invoices are rejected (Stage 2B is INR-only);
 *  - an existing order is REUSED, because Invoice.providerOrderId is @unique
 *    and a second create would fail;
 *  - no Payment row is created merely by opening an order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { InvoiceStatus } from "@prisma/client";
import crypto from "crypto";

type Row = Record<string, any>;

let invoices: Row[];
let auditEvents: Row[];
let updates: Row[];

const createRazorpayOrder = vi.fn(async (_input: any) => ({
  id: "order_NEW",
  amount: _input.amount,
  currency: _input.currency,
  status: "created",
  receipt: _input.receipt,
}));

const settleRazorpayPayment = vi.fn(async (_input: any) => ({
  ok: true as const,
  outcome: "settled" as const,
  invoiceId: "inv_1",
  paymentId: "pay_X",
}));

vi.mock("../services/razorpay.service", async () => {
  const actual = await vi.importActual<any>("../services/razorpay.service");
  return {
    ...actual,
    createRazorpayOrder: (...a: any[]) => createRazorpayOrder(a[0]),
  };
});

vi.mock("../services/razorpayPayment.service", () => ({
  settleRazorpayPayment: (...a: any[]) => settleRazorpayPayment(a[0]),
}));

vi.mock("../services/audit.service", () => ({
  recordBillingEvent: async (type: string, args: any) => {
    auditEvents.push({ type, ...args });
  },
}));

vi.mock("../db/connect", () => ({
  default: {
    invoice: {
      findUnique: async ({ where }: any) => {
        if (where.id) return invoices.find((i) => i.id === where.id) ?? null;
        if (where.providerOrderId)
          return invoices.find((i) => i.providerOrderId === where.providerOrderId) ?? null;
        return null;
      },
      update: async ({ where, data }: any) => {
        updates.push({ where, data });
        const row = invoices.find((i) => i.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  createInvoiceOrderHandler,
  verifyRazorpayPaymentHandler,
} from "./razorpay.controller";

const KEY_SECRET = "test_key_secret_value";
const ORDER = "order_ABC";
const PAYMENT = "pay_XYZ";

const sign = (orderId: string, paymentId: string, secret = KEY_SECRET) =>
  crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

function mockRes() {
  const json = vi.fn();
  const res: any = { json, status: vi.fn(() => ({ json })) };
  res.__json = json;
  res.__code = () => res.status.mock.calls[0]?.[0];
  res.__body = () => res.__json.mock.calls[0]?.[0];
  return res;
}

const req = (over: Row = {}): any => ({
  params: {},
  body: {},
  query: {},
  user: { hotelId: "hotel_1", id: "user_1", role: "OWNER" },
  ...over,
});

const invoice = (over: Row = {}) => {
  const row = {
    id: "inv_1",
    hotelId: "hotel_1",
    number: "INV-2026-00001",
    status: InvoiceStatus.OPEN,
    currency: "INR",
    total: 249900,
    amountPaid: 0,
    provider: null,
    providerOrderId: null,
    ...over,
  };
  invoices.push(row);
  return row;
};

beforeEach(() => {
  invoices = [];
  auditEvents = [];
  updates = [];
  createRazorpayOrder.mockClear();
  settleRazorpayPayment.mockClear();
  process.env.RAZORPAY_KEY_ID = "rzp_test_fakekey";
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  delete process.env.RAZORPAY_ENABLED;
  delete process.env.MOCK_RAZORPAY;
});

// ── Order creation ───────────────────────────────────────────────────────────

describe("createInvoiceOrderHandler", () => {
  it("creates an order for an OPEN INR invoice and returns the publishable key", async () => {
    invoice();
    const res = mockRes();

    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);

    const body = res.__body();
    expect(body).toMatchObject({
      orderId: "order_NEW",
      amount: 249900,
      currency: "INR",
      keyId: "rzp_test_fakekey",
      reused: false,
    });
    // The SECRET must never appear in a response.
    expect(JSON.stringify(body)).not.toContain(KEY_SECRET);
  });

  it("derives the amount from the invoice and IGNORES a client-supplied amount", async () => {
    invoice();
    const res = mockRes();

    await createInvoiceOrderHandler(
      req({ params: { invoiceId: "inv_1" }, body: { amount: 1, total: 1, outstanding: 1 } }),
      res,
    );

    expect(createRazorpayOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 249900 }));
    expect(res.__body().amount).toBe(249900);
  });

  it("charges only the OUTSTANDING balance on a partially paid invoice", async () => {
    invoice({ amountPaid: 49900 });
    const res = mockRes();

    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);

    expect(createRazorpayOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 200000 }));
  });

  it("IDOR: refuses another hotel's invoice with a 404, not a 403", async () => {
    invoice({ hotelId: "hotel_OTHER" });
    const res = mockRes();

    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);

    expect(res.__code()).toBe(404);
    expect(createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("404s for an invoice that does not exist", async () => {
    const res = mockRes();
    await createInvoiceOrderHandler(req({ params: { invoiceId: "nope" } }), res);
    expect(res.__code()).toBe(404);
  });

  it("REUSES an existing order instead of creating a second one", async () => {
    invoice({ providerOrderId: "order_EXISTING", provider: "razorpay" });
    const res = mockRes();

    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);

    expect(createRazorpayOrder).not.toHaveBeenCalled();
    expect(res.__body()).toMatchObject({ orderId: "order_EXISTING", reused: true });
  });

  it("rejects a VOID invoice", async () => {
    invoice({ status: InvoiceStatus.VOID });
    const res = mockRes();
    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);
    expect(res.__code()).toBe(400);
    expect(res.__body().error).toMatch(/voided/i);
  });

  it("rejects an already-PAID invoice", async () => {
    invoice({ status: InvoiceStatus.PAID, amountPaid: 249900 });
    const res = mockRes();
    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);
    expect(res.__code()).toBe(400);
    expect(res.__body().error).toMatch(/already paid/i);
  });

  it("rejects an invoice with nothing outstanding", async () => {
    invoice({ amountPaid: 249900 });
    const res = mockRes();
    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);
    expect(res.__code()).toBe(400);
    expect(res.__body().error).toMatch(/nothing outstanding/i);
  });

  it("REJECTS a NON-INR invoice — Stage 2B is INR only", async () => {
    invoice({ currency: "USD" });
    const res = mockRes();

    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);

    expect(res.__code()).toBe(400);
    expect(res.__body().error).toMatch(/INR/);
    expect(createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("creates NO Payment row — an order is an intent, not a payment", async () => {
    invoice();
    const res = mockRes();

    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);

    // Only the invoice is written, and only with the order id.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data).toEqual({ provider: "razorpay", providerOrderId: "order_NEW" });
  });

  it("audits the order creation", async () => {
    invoice();
    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), mockRes());

    const ev = auditEvents.find((e) => e.type === "payment.gateway_order_created")!;
    expect(ev.hotelId).toBe("hotel_1");
    expect(ev.data).toMatchObject({ invoiceId: "inv_1", orderId: "order_NEW", amount: 249900 });
  });

  it("503s when Razorpay is disabled by feature flag", async () => {
    process.env.RAZORPAY_ENABLED = "false";
    invoice();
    const res = mockRes();
    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);
    expect(res.__code()).toBe(503);
  });

  it("503s when credentials are absent, rather than 500ing", async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    invoice();
    const res = mockRes();
    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);
    expect(res.__code()).toBe(503);
  });

  it("502s when the provider itself errors", async () => {
    const { RazorpayApiError } = await vi.importActual<any>("../services/razorpay.service");
    createRazorpayOrder.mockRejectedValueOnce(new RazorpayApiError("Invalid amount", 400));
    invoice();
    const res = mockRes();

    await createInvoiceOrderHandler(req({ params: { invoiceId: "inv_1" } }), res);

    expect(res.__code()).toBe(502);
  });
});

// ── Verify ───────────────────────────────────────────────────────────────────

describe("verifyRazorpayPaymentHandler", () => {
  const goodBody = () => ({
    razorpay_order_id: ORDER,
    razorpay_payment_id: PAYMENT,
    razorpay_signature: sign(ORDER, PAYMENT),
  });

  it("verifies a correctly signed callback and settles", async () => {
    invoice({ providerOrderId: ORDER });
    const res = mockRes();

    await verifyRazorpayPaymentHandler(req({ body: goodBody() }), res);

    expect(settleRazorpayPayment).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER, paymentId: PAYMENT, source: "checkout_callback" }),
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
  });

  it("REJECTS a forged signature and never settles", async () => {
    invoice({ providerOrderId: ORDER });
    const res = mockRes();

    await verifyRazorpayPaymentHandler(
      req({ body: { ...goodBody(), razorpay_signature: sign(ORDER, PAYMENT, "attacker") } }),
      res,
    );

    expect(res.__code()).toBe(400);
    expect(settleRazorpayPayment).not.toHaveBeenCalled();
  });

  it("REJECTS a signature for a different payment id", async () => {
    invoice({ providerOrderId: ORDER });
    const res = mockRes();

    await verifyRazorpayPaymentHandler(
      req({ body: { ...goodBody(), razorpay_payment_id: "pay_SOMETHING_ELSE" } }),
      res,
    );

    expect(res.__code()).toBe(400);
    expect(settleRazorpayPayment).not.toHaveBeenCalled();
  });

  it("IDOR: a VALID signature does not grant access to another hotel's order", async () => {
    // The signature is genuine — Razorpay really did see this payment — but the
    // order belongs to a different tenant. Ownership is a separate check.
    invoice({ providerOrderId: ORDER, hotelId: "hotel_OTHER" });
    const res = mockRes();

    await verifyRazorpayPaymentHandler(req({ body: goodBody() }), res);

    expect(res.__code()).toBe(404);
    expect(settleRazorpayPayment).not.toHaveBeenCalled();
  });

  it("derives the amount server-side and IGNORES a client-supplied amount", async () => {
    invoice({ providerOrderId: ORDER, total: 249900, amountPaid: 0 });
    const res = mockRes();

    await verifyRazorpayPaymentHandler(
      req({ body: { ...goodBody(), amount: 1, razorpay_amount: 1 } }),
      res,
    );

    expect(settleRazorpayPayment).toHaveBeenCalledWith(expect.objectContaining({ amount: 249900 }));
  });

  it("rejects an incomplete callback", async () => {
    for (const body of [
      { razorpay_payment_id: PAYMENT, razorpay_signature: "x" },
      { razorpay_order_id: ORDER, razorpay_signature: "x" },
      { razorpay_order_id: ORDER, razorpay_payment_id: PAYMENT },
    ]) {
      const res = mockRes();
      await verifyRazorpayPaymentHandler(req({ body }), res);
      expect(res.__code()).toBe(400);
    }
    expect(settleRazorpayPayment).not.toHaveBeenCalled();
  });

  it("404s for a signature over an order we have never seen", async () => {
    const res = mockRes();
    await verifyRazorpayPaymentHandler(req({ body: goodBody() }), res);
    expect(res.__code()).toBe(404);
  });

  it("reports an already-processed payment as such rather than as an error", async () => {
    invoice({ providerOrderId: ORDER });
    settleRazorpayPayment.mockResolvedValueOnce({
      ok: true,
      outcome: "already_processed",
      invoiceId: "inv_1",
      paymentId: PAYMENT,
    } as any);
    const res = mockRes();

    await verifyRazorpayPaymentHandler(req({ body: goodBody() }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "already_processed" }));
  });

  it("surfaces a settlement refusal as a 400 with its machine-readable code", async () => {
    invoice({ providerOrderId: ORDER });
    settleRazorpayPayment.mockResolvedValueOnce({
      ok: false,
      reason: "amount_mismatch",
      invoiceId: "inv_1",
    } as any);
    const res = mockRes();

    await verifyRazorpayPaymentHandler(req({ body: goodBody() }), res);

    expect(res.__code()).toBe(400);
    expect(res.__body().code).toBe("amount_mismatch");
  });
});
