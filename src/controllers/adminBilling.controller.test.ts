/**
 * Admin invoice / payment endpoints.
 *
 * Locks in the P0 corrections to void, which was a money-destroying action with
 * no trail at all:
 *  - a PARTIALLY PAID invoice can no longer be voided — only `PAID` was blocked,
 *    so an invoice with `amountPaid > 0` could be written off while its Payment
 *    rows survived and kept counting toward revenue;
 *  - voiding is AUDITED — every sibling money action recorded an event; this one
 *    did not, so the single operation that writes off a receivable was the only
 *    one with no evidence of who did it;
 *  - the reason is validated and APPENDED — it used to overwrite `notes`,
 *    destroying anything written at issue time, with no validation;
 *  - an already-void invoice is rejected instead of silently re-stamped.
 *
 * Plus the payment status lifecycle now reachable through the API, and the
 * hotel-side billing role gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { InvoiceStatus, PaymentStatus, UserRole, VakettaAdminRole } from "@prisma/client";

type Row = Record<string, any>;

let invoices: Row[];
let payments: Row[];
let auditEvents: Row[];

const recordPayment = vi.fn(async (input: any) => ({ payment: { id: "pay_1", ...input }, settled: true }));
const transitionPayment = vi.fn(async (input: any) => ({
  // `provider` decides manual-vs-gateway in the audit branch; null = manual.
  payment: {
    id: input.paymentId,
    hotelId: "h1",
    invoiceId: "inv_1",
    amount: 249900,
    currency: "INR",
    method: "BANK_TRANSFER",
    reference: "UTR123456",
    provider: null,
  },
  changed: true,
  settled: input.status === "SUCCEEDED",
}));

vi.mock("../services/invoice.service", () => ({
  recordPayment: (...a: any[]) => recordPayment(a[0]),
  transitionPayment: (...a: any[]) => transitionPayment(a[0]),
}));

vi.mock("../services/audit.service", () => ({
  listAuditLog: vi.fn(async () => ({ data: [], total: 0, page: 1, pages: 0, limit: 50 })),
  recordBillingEvent: async (type: string, args: any) => {
    auditEvents.push({ type, ...args });
  },
}));

vi.mock("../db/connect", () => ({
  default: {
    invoice: {
      findUnique: async ({ where }: any) => invoices.find((i) => i.id === where.id) ?? null,
      findMany: async () => invoices,
      count: async () => invoices.length,
      update: async ({ where, data }: any) => {
        const row = invoices.find((i) => i.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    payment: {
      findMany: async () => payments,
      count: async () => payments.length,
    },
    // requireVakettaRole reads the role from the DATABASE, not the token.
    vakettaAdmin: { findUnique: (...a: any[]) => adminFindUnique(a[0]) },
  },
}));

// Typed as the union, not the literal, so a test can resolve any role.
const adminFindUnique = vi.fn(async (_args?: any): Promise<{ role: VakettaAdminRole } | null> => ({
  role: VakettaAdminRole.ADMIN,
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  voidInvoiceHandler,
  recordPaymentHandler,
  transitionPaymentHandler,
  listPaymentsHandler,
} from "./adminBilling.controller";
import { requireHotelRole, requireBillingViewer } from "../middleware/requireHotelRole";
import { requireVakettaRole } from "../middleware/requireVakettaRole";

function mockRes() {
  const json = vi.fn();
  const res: any = { json, status: vi.fn(() => ({ json })) };
  res.__json = json;
  res.__code = () => res.status.mock.calls[0]?.[0];
  return res;
}

const req = (over: Row = {}): any => ({
  params: {},
  body: {},
  query: {},
  vakettaAdmin: { id: "admin_1" },
  ...over,
});

const openInvoice = (over: Row = {}) => {
  const row = {
    id: "inv_1",
    hotelId: "h1",
    number: "INV-2026-00001",
    status: InvoiceStatus.OPEN,
    currency: "INR",
    total: 249900,
    amountPaid: 0,
    notes: null,
    ...over,
  };
  invoices.push(row);
  return row;
};

beforeEach(() => {
  invoices = [];
  payments = [];
  auditEvents = [];
  recordPayment.mockClear();
  transitionPayment.mockClear();
});

// ── Void ─────────────────────────────────────────────────────────────────────

describe("voidInvoiceHandler", () => {
  it("voids an unpaid invoice and records an audit event", async () => {
    openInvoice();
    const res = mockRes();

    await voidInvoiceHandler(req({ params: { id: "inv_1" }, body: { reason: "duplicate billing run" } }), res);

    expect(invoices[0]!.status).toBe(InvoiceStatus.VOID);
    const ev = auditEvents.find((e) => e.type === "invoice.voided")!;
    expect(ev).toBeTruthy();
    expect(ev.actorId).toBe("admin_1");
    expect(ev.actorType).toBe("ADMIN");
    expect(ev.data).toMatchObject({ invoiceId: "inv_1", number: "INV-2026-00001", reason: "duplicate billing run" });
  });

  it("REFUSES to void a partially paid invoice", async () => {
    openInvoice({ amountPaid: 50000 });
    const res = mockRes();

    await voidInvoiceHandler(req({ params: { id: "inv_1" }, body: { reason: "oops" } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.__json.mock.calls[0][0].error).toMatch(/payments recorded against it/i);
    expect(invoices[0]!.status).toBe(InvoiceStatus.OPEN);
    expect(auditEvents).toHaveLength(0);
  });

  it("refuses to void a paid invoice", async () => {
    openInvoice({ status: InvoiceStatus.PAID, amountPaid: 249900 });
    const res = mockRes();

    await voidInvoiceHandler(req({ params: { id: "inv_1" }, body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.__json.mock.calls[0][0].error).toMatch(/refund/i);
  });

  it("refuses to re-void an already void invoice", async () => {
    openInvoice({ status: InvoiceStatus.VOID });
    const res = mockRes();

    await voidInvoiceHandler(req({ params: { id: "inv_1" }, body: { reason: "again" } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.__json.mock.calls[0][0].error).toMatch(/already void/i);
  });

  it("APPENDS the reason instead of destroying notes written at issue time", async () => {
    openInvoice({ notes: "Issued after manual reconciliation." });
    const res = mockRes();

    await voidInvoiceHandler(req({ params: { id: "inv_1" }, body: { reason: "billed twice" } }), res);

    expect(invoices[0]!.notes).toMatch(/^Issued after manual reconciliation\./);
    expect(invoices[0]!.notes).toMatch(/billed twice/);
  });

  it("still voids, and says so, when no reason is given", async () => {
    openInvoice();
    const res = mockRes();

    await voidInvoiceHandler(req({ params: { id: "inv_1" }, body: {} }), res);

    expect(invoices[0]!.status).toBe(InvoiceStatus.VOID);
    expect(invoices[0]!.notes).toMatch(/no reason given/);
  });

  it("rejects an over-long reason rather than silently truncating it", async () => {
    openInvoice();
    const res = mockRes();

    await voidInvoiceHandler(req({ params: { id: "inv_1" }, body: { reason: "x".repeat(501) } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(invoices[0]!.status).toBe(InvoiceStatus.OPEN);
  });

  it("404s for an unknown invoice", async () => {
    const res = mockRes();
    await voidInvoiceHandler(req({ params: { id: "nope" }, body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ── Record payment ───────────────────────────────────────────────────────────

describe("recordPaymentHandler", () => {
  it("defaults to SUCCEEDED — an admin recording a payment asserts money arrived", async () => {
    const res = mockRes();
    await recordPaymentHandler(req({ params: { id: "inv_1" }, body: { amount: 1000 } }), res);

    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({ status: PaymentStatus.SUCCEEDED }));
  });

  it("accepts PENDING so an unverified payment can be logged without crediting", async () => {
    const res = mockRes();
    await recordPaymentHandler(req({ params: { id: "inv_1" }, body: { status: "pending" } }), res);

    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({ status: PaymentStatus.PENDING }));
  });

  it("rejects a status that is not SUCCEEDED or PENDING", async () => {
    const res = mockRes();
    await recordPaymentHandler(req({ params: { id: "inv_1" }, body: { status: "FAILED" } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("rejects a zero amount", async () => {
    const res = mockRes();
    await recordPaymentHandler(req({ params: { id: "inv_1" }, body: { amount: 0 } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects a fractional or non-numeric amount", async () => {
    for (const amount of [12.5, "abc", -100]) {
      const res = mockRes();
      await recordPaymentHandler(req({ params: { id: "inv_1" }, body: { amount } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("attributes the payment to the acting admin", async () => {
    const res = mockRes();
    await recordPaymentHandler(req({ params: { id: "inv_1" }, body: {} }), res);
    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({ recordedByAdminId: "admin_1" }));
  });
});

// ── Payment transitions ──────────────────────────────────────────────────────

describe("transitionPaymentHandler", () => {
  it("moves a payment to SUCCEEDED", async () => {
    const res = mockRes();
    await transitionPaymentHandler(req({ params: { id: "pay_1" }, body: { status: "succeeded" } }), res);

    expect(transitionPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay_1", status: PaymentStatus.SUCCEEDED, actorId: "admin_1" }),
    );
  });

  it("requires a reason to fail a payment", async () => {
    const res = mockRes();
    await transitionPaymentHandler(req({ params: { id: "pay_1" }, body: { status: "FAILED" } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(transitionPayment).not.toHaveBeenCalled();
  });

  it("moves a payment to FAILED with its reason", async () => {
    const res = mockRes();
    await transitionPaymentHandler(
      req({ params: { id: "pay_1" }, body: { status: "FAILED", failureReason: "UTR not found" } }),
      res,
    );

    expect(transitionPayment).toHaveBeenCalledWith(
      expect.objectContaining({ status: PaymentStatus.FAILED, failureReason: "UTR not found" }),
    );
  });

  it("rejects PENDING as a transition target — it is the starting state", async () => {
    const res = mockRes();
    await transitionPaymentHandler(req({ params: { id: "pay_1" }, body: { status: "PENDING" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("surfaces a service-level rejection as a 400, not a 500", async () => {
    transitionPayment.mockRejectedValueOnce(new Error("Cannot transition a SUCCEEDED payment"));
    const res = mockRes();
    await transitionPaymentHandler(req({ params: { id: "pay_1" }, body: { status: "FAILED", failureReason: "x" } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("listPaymentsHandler", () => {
  it("returns a paginated envelope", async () => {
    payments = [{ id: "pay_1" }];
    const res = mockRes();
    await listPaymentsHandler(req({ query: { page: "1", limit: "25" } }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: payments, total: 1, page: 1, limit: 25 }),
    );
  });
});

// ── Manual payment approval / rejection ──────────────────────────────────────

/**
 * Approval must go through the EXISTING transitionPayment — there is no second
 * settlement path — and must be attributable to a named admin. SUPPORT is
 * excluded from every money-moving action by requireBillingAdmin.
 */
describe("manual payment approval", () => {
  it("APPROVE routes through transitionPayment with the reviewing admin", async () => {
    const res = mockRes();
    await transitionPaymentHandler(req({ params: { id: "pay_1" }, body: { status: "SUCCEEDED" } }), res);

    expect(transitionPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay_1", status: PaymentStatus.SUCCEEDED, actorId: "admin_1" }),
    );
  });

  it("audits payment.manual_approved for a non-gateway payment", async () => {
    const res = mockRes();
    await transitionPaymentHandler(req({ params: { id: "pay_1" }, body: { status: "SUCCEEDED" } }), res);

    const ev = auditEvents.find((e) => e.type === "payment.manual_approved")!;
    expect(ev.actorId).toBe("admin_1");
    expect(ev.actorType).toBe("ADMIN");
    expect(ev.data).toMatchObject({ paymentId: "pay_1", amount: 249900, reference: "UTR123456", settled: true });
  });

  it("audits payment.manual_rejected with the rejection reason", async () => {
    const res = mockRes();
    await transitionPaymentHandler(
      req({ params: { id: "pay_1" }, body: { status: "FAILED", failureReason: "UTR not found at bank" } }),
      res,
    );

    const ev = auditEvents.find((e) => e.type === "payment.manual_rejected")!;
    expect(ev.data.rejectionReason).toBe("UTR not found at bank");
    // The rejection reason travels through the EXISTING failureReason field.
    expect(transitionPayment).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: "UTR not found at bank" }),
    );
  });

  it("does NOT emit a manual audit event for a gateway payment", async () => {
    transitionPayment.mockResolvedValueOnce({
      payment: { id: "pay_rzp", hotelId: "h1", invoiceId: "inv_1", amount: 1, currency: "INR", method: "razorpay_upi", provider: "razorpay" },
      changed: true,
      settled: true,
    } as any);
    const res = mockRes();
    await transitionPaymentHandler(req({ params: { id: "pay_rzp" }, body: { status: "SUCCEEDED" } }), res);

    expect(auditEvents.some((e) => String(e.type).startsWith("payment.manual_"))).toBe(false);
  });

  it("emits nothing when the transition did not change anything", async () => {
    transitionPayment.mockResolvedValueOnce({
      payment: { id: "pay_1", provider: null },
      changed: false,
      settled: false,
    } as any);
    const res = mockRes();
    await transitionPaymentHandler(req({ params: { id: "pay_1" }, body: { status: "SUCCEEDED" } }), res);

    expect(auditEvents).toHaveLength(0);
  });

  it("surfaces a stale-PENDING refusal as a 400, not a 500", async () => {
    transitionPayment.mockRejectedValueOnce(
      new Error("Cannot apply a payment to an invoice that is already paid"),
    );
    const res = mockRes();
    await transitionPaymentHandler(req({ params: { id: "pay_1" }, body: { status: "SUCCEEDED" } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("requires a reason to reject — a rejection without one is unauditable", async () => {
    const res = mockRes();
    await transitionPaymentHandler(req({ params: { id: "pay_1" }, body: { status: "FAILED" } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(transitionPayment).not.toHaveBeenCalled();
  });
});

describe("SUPPORT cannot approve payments", () => {
  it("requireBillingAdmin denies SUPPORT", async () => {
    adminFindUnique.mockResolvedValueOnce({ role: VakettaAdminRole.SUPPORT });
    const next = vi.fn();
    const res = mockRes();

    await requireVakettaRole(VakettaAdminRole.SUPER_ADMIN, VakettaAdminRole.ADMIN)(
      { vakettaAdmin: { id: "admin_support" } } as any,
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows SUPER_ADMIN and ADMIN", async () => {
    for (const role of [VakettaAdminRole.SUPER_ADMIN, VakettaAdminRole.ADMIN]) {
      adminFindUnique.mockResolvedValueOnce({ role });
      const next = vi.fn();
      await requireVakettaRole(VakettaAdminRole.SUPER_ADMIN, VakettaAdminRole.ADMIN)(
        { vakettaAdmin: { id: "a" } } as any,
        mockRes(),
        next,
      );
      expect(next).toHaveBeenCalled();
    }
  });
});

// ── Hotel-side billing role gate ─────────────────────────────────────────────

describe("requireHotelRole", () => {
  const next = vi.fn();
  beforeEach(() => next.mockClear());

  it("lets an OWNER through", () => {
    const res = mockRes();
    requireBillingViewer({ user: { role: UserRole.OWNER } } as any, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("lets an ADMIN through", () => {
    const res = mockRes();
    requireBillingViewer({ user: { role: UserRole.ADMIN } } as any, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("blocks MANAGER and STAFF from the hotel's commercial data", () => {
    for (const role of [UserRole.MANAGER, UserRole.STAFF]) {
      const res = mockRes();
      requireBillingViewer({ user: { role } } as any, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(next).not.toHaveBeenCalled();
  });

  it("401s when auth did not run", () => {
    const res = mockRes();
    requireBillingViewer({} as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("fails CLOSED on a missing or unrecognised role", () => {
    for (const user of [{}, { role: null }, { role: "SUPERUSER" }, { role: 42 }]) {
      const res = mockRes();
      requireBillingViewer({ user } as any, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(next).not.toHaveBeenCalled();
  });

  it("is composable for other role sets", () => {
    const res = mockRes();
    requireHotelRole(UserRole.MANAGER)({ user: { role: UserRole.MANAGER } } as any, res, next);
    expect(next).toHaveBeenCalled();
  });
});
