/**
 * Manual payment submission endpoint.
 *
 * Locks in what the browser is and is not allowed to decide. It may choose one
 * of its OWN invoices and an amount up to the outstanding balance; it may not
 * choose the hotel, the status, or whether anything is verified.
 *
 * Also pins the input validation — method allowlist, reference requirement,
 * claimed-date sanity, proof MIME allowlist — and that a foreign invoice is a
 * 404 rather than a 403.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymentStatus, UserRole } from "@prisma/client";

type Row = Record<string, any>;

let submitResult: any;
let submitCalls: Row[];
let listResult: any[];

vi.mock("../services/manualPayment.service", () => ({
  submitManualPayment: async (input: any) => {
    submitCalls.push(input);
    return submitResult;
  },
  listHotelPayments: async (_hotelId: string) => listResult,
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  submitManualPaymentHandler,
  listMyPaymentsHandler,
} from "./manualPayment.controller";
import { requireBillingViewer } from "../middleware/requireHotelRole";

function mockRes() {
  const json = vi.fn();
  const res: any = { json, status: vi.fn(() => ({ json })) };
  res.__json = json;
  res.__code = () => res.status.mock.calls[0]?.[0];
  res.__body = () => res.__json.mock.calls[0]?.[0];
  return res;
}

const VALID = {
  amount: "249900",
  method: "BANK_TRANSFER",
  claimedPaidAt: "2026-08-20",
  reference: "UTR123456",
};

const req = (over: Row = {}): any => ({
  params: { invoiceId: "inv_1" },
  body: { ...VALID },
  query: {},
  user: { hotelId: "hotel_1", id: "user_1", role: "OWNER" },
  ...over,
});

beforeEach(() => {
  submitCalls = [];
  listResult = [];
  submitResult = { ok: true, paymentId: "pay_1", status: PaymentStatus.PENDING };
  vi.setSystemTime(new Date("2026-08-25T12:00:00Z"));
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe("submitManualPaymentHandler", () => {
  it("submits a valid claim and returns 201 PENDING", async () => {
    const res = mockRes();
    await submitManualPaymentHandler(req(), res);

    expect(res.__code()).toBe(201);
    expect(res.__body()).toMatchObject({ paymentId: "pay_1", status: PaymentStatus.PENDING });
    expect(res.__body().message).toMatch(/review/i);
  });

  it("takes the hotel and user from the JWT, never the body", async () => {
    const res = mockRes();
    await submitManualPaymentHandler(
      req({ body: { ...VALID, hotelId: "hotel_ATTACKER", submittedByUserId: "user_ATTACKER" } }),
      res,
    );

    expect(submitCalls[0]).toMatchObject({ hotelId: "hotel_1", submittedByUserId: "user_1" });
  });

  it("never lets the client choose a status", async () => {
    const res = mockRes();
    await submitManualPaymentHandler(req({ body: { ...VALID, status: "SUCCEEDED" } }), res);

    expect(submitCalls[0]!.status).toBeUndefined();
    expect(res.__body().status).toBe(PaymentStatus.PENDING);
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe("validation", () => {
  it("rejects a zero, negative, fractional or non-numeric amount", async () => {
    for (const amount of ["0", "-100", "12.5", "abc", ""]) {
      const res = mockRes();
      await submitManualPaymentHandler(req({ body: { ...VALID, amount } }), res);
      expect(res.__code()).toBe(400);
    }
    expect(submitCalls).toHaveLength(0);
  });

  it("rejects a method outside the allowlist", async () => {
    for (const method of ["BITCOIN", "paypal", "", "DROP TABLE"]) {
      const res = mockRes();
      await submitManualPaymentHandler(req({ body: { ...VALID, method } }), res);
      expect(res.__code()).toBe(400);
    }
    expect(submitCalls).toHaveLength(0);
  });

  it("accepts every allowlisted method", async () => {
    for (const method of ["BANK_TRANSFER", "UPI", "CASH", "CHEQUE", "OTHER"]) {
      const res = mockRes();
      await submitManualPaymentHandler(req({ body: { ...VALID, method } }), res);
      expect(res.__code()).toBe(201);
    }
  });

  it("normalises method case", async () => {
    const res = mockRes();
    await submitManualPaymentHandler(req({ body: { ...VALID, method: "upi" } }), res);
    expect(submitCalls[0]!.method).toBe("UPI");
  });

  it("REQUIRES a reference for every method except CASH", async () => {
    for (const method of ["BANK_TRANSFER", "UPI", "CHEQUE", "OTHER"]) {
      const res = mockRes();
      await submitManualPaymentHandler(req({ body: { ...VALID, method, reference: "" } }), res);
      expect(res.__code()).toBe(400);
      expect(res.__body().error).toMatch(/reference/i);
    }
  });

  it("allows CASH with no reference — there is nothing to reference", async () => {
    const res = mockRes();
    await submitManualPaymentHandler(req({ body: { ...VALID, method: "CASH", reference: "" } }), res);
    expect(res.__code()).toBe(201);
  });

  it("rejects a FUTURE payment date", async () => {
    const res = mockRes();
    await submitManualPaymentHandler(req({ body: { ...VALID, claimedPaidAt: "2027-01-01" } }), res);
    expect(res.__code()).toBe(400);
    expect(res.__body().error).toMatch(/future/i);
  });

  it("rejects a missing or unparseable date", async () => {
    for (const claimedPaidAt of ["", "not-a-date", "99/99/9999"]) {
      const res = mockRes();
      await submitManualPaymentHandler(req({ body: { ...VALID, claimedPaidAt } }), res);
      expect(res.__code()).toBe(400);
    }
  });

  it("rejects an over-long reference or notes rather than truncating", async () => {
    const long = mockRes();
    await submitManualPaymentHandler(req({ body: { ...VALID, reference: "x".repeat(121) } }), long);
    expect(long.__code()).toBe(400);

    const notes = mockRes();
    await submitManualPaymentHandler(req({ body: { ...VALID, notes: "y".repeat(501) } }), notes);
    expect(notes.__code()).toBe(400);
  });
});

// ── Proof upload ─────────────────────────────────────────────────────────────

describe("proof upload", () => {
  const file = (mimetype: string) => ({ buffer: Buffer.from("bytes"), mimetype });

  it("accepts images and PDF", async () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp", "application/pdf"]) {
      const res = mockRes();
      await submitManualPaymentHandler(req({ file: file(mime) }), res);
      expect(res.__code()).toBe(201);
    }
  });

  it("REJECTS an executable or archive masquerading as proof", async () => {
    for (const mime of ["application/x-msdownload", "application/zip", "text/html", "image/svg+xml"]) {
      const res = mockRes();
      await submitManualPaymentHandler(req({ file: file(mime) }), res);
      expect(res.__code()).toBe(400);
    }
    expect(submitCalls).toHaveLength(0);
  });

  it("passes the buffer through for magic-byte sniffing downstream", async () => {
    const res = mockRes();
    await submitManualPaymentHandler(req({ file: file("image/png") }), res);
    expect(submitCalls[0]!.proof).toMatchObject({ mimeType: "image/png" });
  });
});

// ── Service refusals → HTTP ──────────────────────────────────────────────────

describe("service refusals", () => {
  it("maps a foreign/missing invoice to 404, never 403", async () => {
    submitResult = { ok: false, reason: "invoice_not_found", message: "Invoice not found" };
    const res = mockRes();
    await submitManualPaymentHandler(req(), res);
    expect(res.__code()).toBe(404);
  });

  it("maps business refusals to 400 with a machine-readable code", async () => {
    for (const reason of ["invoice_void", "invoice_paid", "duplicate_pending", "nothing_outstanding"]) {
      submitResult = { ok: false, reason, message: "nope" };
      const res = mockRes();
      await submitManualPaymentHandler(req(), res);
      expect(res.__code()).toBe(400);
      expect(res.__body().code).toBe(reason);
    }
  });

  it("returns the real outstanding figure on an over-payment", async () => {
    submitResult = {
      ok: false,
      reason: "amount_exceeds_outstanding",
      message: "too much",
      outstanding: 49900,
    };
    const res = mockRes();
    await submitManualPaymentHandler(req(), res);
    expect(res.__body().outstanding).toBe(49900);
  });
});

// ── Authorization ────────────────────────────────────────────────────────────

describe("authorization", () => {
  const next = vi.fn();
  beforeEach(() => next.mockClear());

  it("allows OWNER and ADMIN", () => {
    for (const role of [UserRole.OWNER, UserRole.ADMIN]) {
      requireBillingViewer({ user: { role } } as any, mockRes(), next);
    }
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("BLOCKS MANAGER and STAFF from submitting payments", () => {
    for (const role of [UserRole.MANAGER, UserRole.STAFF]) {
      const res = mockRes();
      requireBillingViewer({ user: { role } } as any, res, next);
      expect(res.__code()).toBe(403);
    }
    expect(next).not.toHaveBeenCalled();
  });
});

describe("listMyPaymentsHandler", () => {
  it("returns the hotel's own payments", async () => {
    listResult = [{ id: "pay_1", status: "PENDING" }];
    const res = mockRes();
    await listMyPaymentsHandler(req(), res);
    expect(res.json).toHaveBeenCalledWith(listResult);
  });
});
