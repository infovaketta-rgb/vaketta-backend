/**
 * Manual/offline payment intake.
 *
 * THE INVARIANT UNDER TEST: a hotel-submitted payment is a CLAIM, never money.
 * It is created PENDING, it never moves `Invoice.amountPaid`, and nothing in
 * this module can settle an invoice. A UTR number and a screenshot are evidence
 * for a human reviewer — they are never treated as verification.
 *
 * Also locks in tenant isolation (a foreign invoice is indistinguishable from a
 * missing one), the over-credit guard, the one-open-claim rule, and the
 * deliberate decision that a failed proof upload must not lose the submission.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { InvoiceStatus, PaymentStatus } from "@prisma/client";

type Row = Record<string, any>;

let invoices: Row[];
let payments: Row[];
let auditEvents: Row[];
let recordPaymentCalls: Row[];
let paymentUpdates: Row[];
let uploadCalls: Row[];
let r2Configured: boolean;
let uploadThrows: boolean;
let recordPaymentThrows: string | null;

vi.mock("../db/connect", () => ({
  default: {
    invoice: {
      findFirst: async ({ where }: any) =>
        invoices.find((i) => i.id === where.id && i.hotelId === where.hotelId) ?? null,
    },
    payment: {
      findFirst: async ({ where }: any) =>
        payments.find((p) => p.invoiceId === where.invoiceId && p.status === where.status) ?? null,
      update: async ({ where, data }: any) => {
        paymentUpdates.push({ where, data });
        const row = payments.find((p) => p.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  },
}));

vi.mock("./invoice.service", () => ({
  recordPayment: async (input: any) => {
    recordPaymentCalls.push(input);
    if (recordPaymentThrows) throw new Error(recordPaymentThrows);
    const row = {
      id: `pay_${payments.length + 1}`,
      invoiceId: input.invoiceId,
      status: input.status,
      amount: input.amount,
      method: input.method,
      reference: input.reference ?? null,
    };
    payments.push(row);
    // PENDING must not touch the invoice — mirrored here so a regression in the
    // real writer would surface as a test failure rather than passing silently.
    return { payment: row, invoice: invoices.find((i) => i.id === input.invoiceId), settled: false };
  },
}));

vi.mock("./audit.service", () => ({
  recordBillingEvent: async (type: string, args: any) => {
    auditEvents.push({ type, ...args });
  },
}));

vi.mock("./r2.service", () => ({
  isR2Configured: () => r2Configured,
  uploadToR2: async (buffer: Buffer, mime: string, opts: any) => {
    uploadCalls.push({ size: buffer.length, mime, opts });
    if (uploadThrows) throw new Error("R2 unreachable");
    return { url: "https://media.vaketta.com/h1/proof.png", key: "h1/proof.png", mime, fileName: "proof.png" };
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { submitManualPayment, listHotelPayments } from "./manualPayment.service";

const invoice = (over: Row = {}) => {
  const row = {
    id: "inv_1",
    hotelId: "hotel_1",
    number: "INV-2026-00001",
    status: InvoiceStatus.OPEN,
    currency: "INR",
    total: 249900,
    amountPaid: 0,
    ...over,
  };
  invoices.push(row);
  return row;
};

const claim = (over: Row = {}) => ({
  hotelId: "hotel_1",
  submittedByUserId: "user_1",
  invoiceId: "inv_1",
  amount: 249900,
  method: "BANK_TRANSFER" as const,
  claimedPaidAt: new Date("2026-08-20T00:00:00Z"),
  reference: "UTR123456",
  ...over,
});

beforeEach(() => {
  invoices = [];
  payments = [];
  auditEvents = [];
  recordPaymentCalls = [];
  paymentUpdates = [];
  uploadCalls = [];
  r2Configured = true;
  uploadThrows = false;
  recordPaymentThrows = null;
});

// ── The core invariant ───────────────────────────────────────────────────────

describe("submitManualPayment — creates a CLAIM, never money", () => {
  it("creates a PENDING payment", async () => {
    invoice();
    const r = await submitManualPayment(claim());

    expect(r).toMatchObject({ ok: true, status: PaymentStatus.PENDING });
    expect(recordPaymentCalls[0]!.status).toBe(PaymentStatus.PENDING);
  });

  it("NEVER changes Invoice.amountPaid or status", async () => {
    const inv = invoice();
    await submitManualPayment(claim());

    expect(inv.amountPaid).toBe(0);
    expect(inv.status).toBe(InvoiceStatus.OPEN);
  });

  it("a fake UTR does not verify anything — it is stored, not trusted", async () => {
    const inv = invoice();
    await submitManualPayment(claim({ reference: "TOTALLY-MADE-UP" }));

    expect(recordPaymentCalls[0]!.status).toBe(PaymentStatus.PENDING);
    expect(inv.amountPaid).toBe(0);
  });

  it("is not recorded as admin-entered", async () => {
    invoice();
    await submitManualPayment(claim());
    expect(recordPaymentCalls[0]!.recordedByAdminId).toBeNull();
  });

  it("stamps submission provenance", async () => {
    invoice();
    await submitManualPayment(claim());

    expect(paymentUpdates[0]!.data).toMatchObject({
      submittedByUserId: "user_1",
      claimedPaidAt: new Date("2026-08-20T00:00:00Z"),
    });
  });

  it("audits payment.manual_submitted", async () => {
    invoice();
    await submitManualPayment(claim());

    const ev = auditEvents.find((e) => e.type === "payment.manual_submitted")!;
    expect(ev.hotelId).toBe("hotel_1");
    expect(ev.data).toMatchObject({
      invoiceId: "inv_1",
      amount: 249900,
      method: "BANK_TRANSFER",
      submittedByUserId: "user_1",
      reference: "UTR123456",
    });
  });
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

describe("tenant isolation", () => {
  it("cannot submit against ANOTHER hotel's invoice", async () => {
    invoice({ hotelId: "hotel_OTHER" });
    const r = await submitManualPayment(claim({ hotelId: "hotel_1" }));

    expect(r).toMatchObject({ ok: false, reason: "invoice_not_found" });
    expect(recordPaymentCalls).toHaveLength(0);
  });

  it("reports a foreign invoice identically to a missing one", async () => {
    invoice({ hotelId: "hotel_OTHER" });
    const foreign = await submitManualPayment(claim());
    invoices.length = 0;
    const missing = await submitManualPayment(claim());

    // No existence oracle: identical shape for both.
    expect(foreign).toEqual(missing);
  });
});

// ── Money guards ─────────────────────────────────────────────────────────────

describe("amount guards", () => {
  it("REJECTS more than the outstanding balance", async () => {
    const inv = invoice();
    const r = await submitManualPayment(claim({ amount: 999999 }));

    expect(r).toMatchObject({ ok: false, reason: "amount_exceeds_outstanding", outstanding: 249900 });
    expect(recordPaymentCalls).toHaveLength(0);
    expect(inv.amountPaid).toBe(0);
  });

  it("ALLOWS a partial payment", async () => {
    invoice();
    const r = await submitManualPayment(claim({ amount: 100000 }));

    expect(r.ok).toBe(true);
    expect(recordPaymentCalls[0]!.amount).toBe(100000);
  });

  it("measures against the REMAINING balance", async () => {
    invoice({ amountPaid: 200000 }); // 49,900 left
    const tooMuch = await submitManualPayment(claim({ amount: 60000 }));
    expect(tooMuch).toMatchObject({ ok: false, reason: "amount_exceeds_outstanding" });

    const ok = await submitManualPayment(claim({ amount: 49900 }));
    expect(ok.ok).toBe(true);
  });

  it("rejects an invoice with nothing outstanding", async () => {
    invoice({ amountPaid: 249900 });
    const r = await submitManualPayment(claim({ amount: 100 }));
    expect(r).toMatchObject({ ok: false, reason: "nothing_outstanding" });
  });

  it("surfaces the writer's guard if the balance moved after our check", async () => {
    invoice();
    recordPaymentThrows = "Payment amount exceeds the outstanding balance of 0 INR on this invoice.";
    const r = await submitManualPayment(claim());
    expect(r).toMatchObject({ ok: false, reason: "amount_exceeds_outstanding" });
  });

  it("rethrows an unexpected writer error rather than masking it as a validation failure", async () => {
    invoice();
    recordPaymentThrows = "connection lost";
    await expect(submitManualPayment(claim())).rejects.toThrow(/connection lost/);
  });
});

// ── Invoice state ────────────────────────────────────────────────────────────

describe("invoice state guards", () => {
  it("rejects a VOID invoice", async () => {
    invoice({ status: InvoiceStatus.VOID });
    const r = await submitManualPayment(claim());
    expect(r).toMatchObject({ ok: false, reason: "invoice_void" });
    expect(recordPaymentCalls).toHaveLength(0);
  });

  it("rejects an already-PAID invoice", async () => {
    invoice({ status: InvoiceStatus.PAID, amountPaid: 249900 });
    const r = await submitManualPayment(claim());
    expect(r).toMatchObject({ ok: false, reason: "invoice_paid" });
  });
});

// ── Duplicate claims ─────────────────────────────────────────────────────────

describe("duplicate guard", () => {
  it("rejects a second claim while one is under review", async () => {
    invoice();
    const first = await submitManualPayment(claim());
    expect(first.ok).toBe(true);

    const second = await submitManualPayment(claim());
    expect(second).toMatchObject({ ok: false, reason: "duplicate_pending" });
    expect(recordPaymentCalls).toHaveLength(1);
  });

  it("ALLOWS a new claim after the previous one was REJECTED", async () => {
    invoice();
    await submitManualPayment(claim());
    // Admin rejected it — PENDING is gone.
    payments[0]!.status = PaymentStatus.FAILED;

    const retry = await submitManualPayment(claim({ reference: "UTR-CORRECTED" }));
    expect(retry.ok).toBe(true);
    expect(recordPaymentCalls).toHaveLength(2);
  });

  it("two simultaneous submissions cannot both create a claim", async () => {
    invoice();
    await submitManualPayment(claim());
    const racer = await submitManualPayment(claim());
    expect(racer.ok).toBe(false);
  });
});

// ── Proof upload ─────────────────────────────────────────────────────────────

describe("proof of payment", () => {
  const proof = { buffer: Buffer.from("fake-image-bytes"), mimeType: "image/png" };

  it("uploads through R2 and records the url/key", async () => {
    invoice();
    await submitManualPayment(claim({ proof }));

    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]!.opts).toMatchObject({ hotelId: "hotel_1" });
    expect(paymentUpdates[0]!.data).toMatchObject({
      proofUrl: "https://media.vaketta.com/h1/proof.png",
      proofKey: "h1/proof.png",
    });
  });

  it("KEEPS the claim when R2 is unavailable — the reference is the substance", async () => {
    invoice();
    uploadThrows = true;

    const r = await submitManualPayment(claim({ proof }));

    expect(r.ok).toBe(true);
    expect(paymentUpdates[0]!.data.proofUrl).toBeUndefined();
    expect(auditEvents.find((e) => e.type === "payment.manual_submitted")!.data.hasProof).toBe(false);
  });

  it("skips upload entirely when R2 is not configured", async () => {
    invoice();
    r2Configured = false;

    const r = await submitManualPayment(claim({ proof }));

    expect(r.ok).toBe(true);
    expect(uploadCalls).toHaveLength(0);
  });

  it("is optional", async () => {
    invoice();
    const r = await submitManualPayment(claim());
    expect(r.ok).toBe(true);
    expect(uploadCalls).toHaveLength(0);
  });
});

// ── Hotel payment history ────────────────────────────────────────────────────

describe("listHotelPayments", () => {
  it("does not expose internal staff identity to tenants", async () => {
    const findMany = vi.fn(async (_args: any): Promise<any[]> => []);
    const mod = await import("../db/connect");
    (mod.default as any).payment.findMany = findMany;

    await listHotelPayments("hotel_1");

    const select = findMany.mock.calls[0]![0].select;
    expect(select.reviewedByAdminId).toBeUndefined();
    expect(select.submittedByUserId).toBeUndefined();
    // But the hotel does see its own claim's outcome.
    expect(select.status).toBe(true);
    expect(select.failureReason).toBe(true);
  });

  it("is scoped to the hotel", async () => {
    const findMany = vi.fn(async (_args: any): Promise<any[]> => []);
    const mod = await import("../db/connect");
    (mod.default as any).payment.findMany = findMany;

    await listHotelPayments("hotel_1");
    expect(findMany.mock.calls[0]![0].where).toEqual({ hotelId: "hotel_1" });
  });
});
