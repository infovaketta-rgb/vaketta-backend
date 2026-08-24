/**
 * Invoice issuance, tax, and payment settlement.
 *
 * This file exists because the money-settlement path was the ONLY billing code
 * with no tests: period maths had 57, entitlement 30, and the function that
 * decides whether a customer's payment counts had none.
 *
 * Locks in:
 *  - settlement REACTIVATES a suspended hotel (the P0 bug: paying an invoice
 *    changed nothing outside Invoice/Payment, so a hotel suspended by dunning
 *    stayed suspended after paying the very invoice it was suspended for);
 *  - PENDING and FAILED payments never touch `amountPaid` — status used to be
 *    hardcoded SUCCEEDED, so a row's existence meant "money received";
 *  - PENDING → SUCCEEDED settles identically to a payment recorded as confirmed
 *    up front, and is idempotent under webhook redelivery;
 *  - tax is integer-only and reduces to the old formula at rate 0, so no
 *    historical invoice total changes;
 *  - reactivation failures never propagate — the money is already committed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma, InvoiceStatus, PaymentStatus } from "@prisma/client";

type Row = Record<string, any>;

let invoices: Row[];
let payments: Row[];
let auditEvents: Row[];
let reactivateCalls: Row[];
let reactivateThrows: boolean;
let invoiceCreateFails: "p2002" | null;

const findInvoice = (where: any): Row | null => {
  if (where.id) return invoices.find((i) => i.id === where.id) ?? null;
  const k = where.hotelId_periodStart;
  if (k) {
    return (
      invoices.find(
        (i) => i.hotelId === k.hotelId && i.periodStart?.getTime() === k.periodStart?.getTime(),
      ) ?? null
    );
  }
  return null;
};

const db: Row = {
  $executeRaw: async () => 1,
  $transaction: async (fn: any) => fn(db),
  invoice: {
    findUnique: async (args: any) => findInvoice(args.where),
    findMany: async (args: any) =>
      invoices.filter(
        (i) =>
          (!args.where?.hotelId || i.hotelId === args.where.hotelId) &&
          (!args.where?.status || i.status === args.where.status),
      ),
    findFirst: async () => invoices.filter((i) => i.number).sort((a, b) => b.number.localeCompare(a.number))[0] ?? null,
    create: async (args: any) => {
      if (invoiceCreateFails === "p2002") {
        invoiceCreateFails = null;
        throw new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["hotelId", "periodStart"] },
        });
      }
      const row = { id: `inv_${invoices.length + 1}`, amountPaid: 0, notes: null, ...args.data };
      invoices.push(row);
      return row;
    },
    update: async (args: any) => {
      const row = findInvoice(args.where)!;
      Object.assign(row, args.data);
      return row;
    },
  },
  payment: {
    findUnique: async (args: any) => payments.find((p) => p.id === args.where.id) ?? null,
    findUniqueOrThrow: async (args: any) => {
      const p = payments.find((x) => x.id === args.where.id);
      if (!p) throw new Error("not found");
      return p;
    },
    create: async (args: any) => {
      const row = { id: `pay_${payments.length + 1}`, ...args.data };
      payments.push(row);
      return row;
    },
    updateMany: async (args: any) => {
      const matched = payments.filter(
        (p) => p.id === args.where.id && (!args.where.status || p.status === args.where.status),
      );
      matched.forEach((p) => Object.assign(p, args.data));
      return { count: matched.length };
    },
  },
};

vi.mock("../db/connect", () => ({
  default: new Proxy({} as any, { get: (_t, p) => (db as any)[p] }),
}));

vi.mock("./audit.service", () => ({
  recordBillingEvent: async (type: string, args: any) => {
    auditEvents.push({ type, ...args });
  },
}));

// Dynamically imported by reactivateAfterSettlement — the cycle-breaking pattern.
vi.mock("./billing.service", () => ({
  reactivateAfterPayment: async (hotelId: string, opts: any) => {
    reactivateCalls.push({ hotelId, ...opts });
    if (reactivateThrows) throw new Error("reactivation exploded");
    return { reactivated: true, subscriptionId: "sub_1" };
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  buildLineItems,
  computeTax,
  issueInvoice,
  recordPayment,
  transitionPayment,
  outstandingBalance,
} from "./invoice.service";

const TERMS = {
  conversationLimit: 1000,
  aiReplyLimit: 500,
  extraConversationCharge: 50,
  extraAiReplyCharge: 200,
};

const P_START = new Date("2026-08-15T00:00:00Z");
const P_END = new Date("2026-09-15T00:00:00Z");

const baseInput = (over: Row = {}) => ({
  hotelId: "hotel_1",
  subscriptionId: "sub_1",
  currency: "INR",
  subscriptionAmount: 249900,
  usage: { conversationsUsed: 0, aiRepliesUsed: 0 },
  terms: TERMS,
  periodStart: P_START,
  periodEnd: P_END,
  ...over,
});

const openInvoice = (over: Row = {}): Row => {
  const row = {
    id: "inv_1",
    hotelId: "hotel_1",
    number: "INV-2026-00001",
    status: InvoiceStatus.OPEN,
    currency: "INR",
    subtotal: 249900,
    overageTotal: 0,
    taxTotal: 0,
    total: 249900,
    amountPaid: 0,
    periodStart: P_START,
    periodEnd: P_END,
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
  reactivateCalls = [];
  reactivateThrows = false;
  invoiceCreateFails = null;
});

// ── Tax ──────────────────────────────────────────────────────────────────────

describe("computeTax", () => {
  it("is zero at rate zero — every pre-tax invoice total is unchanged", () => {
    expect(computeTax(249900, 0)).toBe(0);
    expect(computeTax(249900, undefined)).toBe(0);
    expect(computeTax(249900, null)).toBe(0);
  });

  it("computes 18% GST in integer minor units", () => {
    expect(computeTax(249900, 1800)).toBe(44982);
  });

  it("rounds once, and never returns a fraction", () => {
    // 1001 * 18% = 180.18 → 180, not 180.18
    const t = computeTax(1001, 1800);
    expect(t).toBe(180);
    expect(Number.isInteger(t)).toBe(true);
  });

  it("treats a negative or non-finite base as zero rather than producing negative tax", () => {
    expect(computeTax(-500, 1800)).toBe(0);
    expect(computeTax(Number.NaN, 1800)).toBe(0);
  });

  it("ignores a negative rate", () => {
    expect(computeTax(100000, -1800)).toBe(0);
  });
});

describe("buildLineItems", () => {
  it("adds no tax line at rate 0", () => {
    const { lineItems, taxTotal } = buildLineItems(baseInput() as any);
    expect(taxTotal).toBe(0);
    expect(lineItems.some((i) => i.kind === "tax")).toBe(false);
  });

  it("taxes the subscription AND the overage, not the subscription alone", () => {
    const { taxTotal, overageTotal } = buildLineItems(
      baseInput({
        usage: { conversationsUsed: 1100, aiRepliesUsed: 0 }, // 100 over × 50 = 5000
        taxRate: 1800,
      }) as any,
    );
    expect(overageTotal).toBe(5000);
    expect(taxTotal).toBe(computeTax(249900 + 5000, 1800));
  });

  it("uses the supplied label, else derives a readable percentage", () => {
    const labelled = buildLineItems(baseInput({ taxRate: 1800, taxLabel: "GST 18%" }) as any);
    expect(labelled.lineItems.find((i) => i.kind === "tax")!.description).toBe("GST 18%");

    const derived = buildLineItems(baseInput({ taxRate: 1800 }) as any);
    expect(derived.lineItems.find((i) => i.kind === "tax")!.description).toBe("Tax (18%)");
  });
});

// ── Issuance ─────────────────────────────────────────────────────────────────

describe("issueInvoice", () => {
  it("total = subtotal + overage + tax, and snapshots the rate", async () => {
    const inv = await issueInvoice(
      baseInput({ usage: { conversationsUsed: 1100, aiRepliesUsed: 0 }, taxRate: 1800, taxLabel: "GST 18%" }) as any,
    );
    const expectedTax = computeTax(249900 + 5000, 1800);
    expect(inv.subtotal).toBe(249900);
    expect(inv.overageTotal).toBe(5000);
    expect(inv.taxTotal).toBe(expectedTax);
    expect(inv.total).toBe(249900 + 5000 + expectedTax);
    // Snapshotted so a later Plan tax change never re-taxes a sent invoice.
    expect(inv.taxRate).toBe(1800);
    expect(inv.taxLabel).toBe("GST 18%");
  });

  it("reduces to the pre-tax formula when no rate is given", async () => {
    const inv = await issueInvoice(baseInput() as any);
    expect(inv.total).toBe(inv.subtotal + inv.overageTotal);
    expect(inv.taxTotal).toBe(0);
  });

  it("is idempotent — an existing invoice for the period is returned untouched", async () => {
    const first = await issueInvoice(baseInput() as any);
    const second = await issueInvoice(baseInput({ subscriptionAmount: 999999 }) as any);
    expect(second.id).toBe(first.id);
    expect(second.total).toBe(first.total);
    expect(invoices).toHaveLength(1);
  });

  it("resolves a concurrent P2002 to the winner rather than throwing", async () => {
    invoiceCreateFails = "p2002";
    // The winner lands first, as a concurrent tick would have written it.
    openInvoice({ id: "inv_winner", periodStart: P_START });
    const inv = await issueInvoice(baseInput() as any);
    expect(inv.id).toBe("inv_winner");
  });

  it("settles a zero-total invoice on creation — never dun for nothing", async () => {
    const inv = await issueInvoice(baseInput({ subscriptionAmount: 0 }) as any);
    expect(inv.total).toBe(0);
    expect(inv.status).toBe(InvoiceStatus.PAID);
    expect(inv.paidAt).toBeInstanceOf(Date);
  });
});

// ── recordPayment ────────────────────────────────────────────────────────────

describe("recordPayment", () => {
  it("defaults to SUCCEEDED, credits the invoice and settles it", async () => {
    openInvoice();
    const r = await recordPayment({ invoiceId: "inv_1" });
    expect(r.payment.status).toBe(PaymentStatus.SUCCEEDED);
    expect(r.settled).toBe(true);
    expect(r.invoice.amountPaid).toBe(249900);
    expect(r.invoice.status).toBe(InvoiceStatus.PAID);
  });

  it("defaults the amount to the outstanding balance, not the total", async () => {
    openInvoice({ amountPaid: 100000 });
    const r = await recordPayment({ invoiceId: "inv_1" });
    expect(r.payment.amount).toBe(149900);
    expect(r.invoice.amountPaid).toBe(249900);
  });

  it("REACTIVATES the hotel once the invoice is settled", async () => {
    openInvoice();
    await recordPayment({ invoiceId: "inv_1" });
    expect(reactivateCalls).toEqual([{ hotelId: "hotel_1", invoiceId: "inv_1" }]);
  });

  it("does NOT reactivate on a partial payment", async () => {
    openInvoice();
    const r = await recordPayment({ invoiceId: "inv_1", amount: 1000 });
    expect(r.settled).toBe(false);
    expect(reactivateCalls).toHaveLength(0);
  });

  it("a PENDING payment creates a row but does not credit the invoice", async () => {
    openInvoice();
    const r = await recordPayment({ invoiceId: "inv_1", status: PaymentStatus.PENDING });
    expect(r.payment.status).toBe(PaymentStatus.PENDING);
    expect(r.settled).toBe(false);
    expect(r.invoice.amountPaid).toBe(0);
    expect(r.invoice.status).toBe(InvoiceStatus.OPEN);
    expect(reactivateCalls).toHaveLength(0);
  });

  it("a FAILED payment does not credit the invoice either", async () => {
    openInvoice();
    const r = await recordPayment({
      invoiceId: "inv_1",
      status: PaymentStatus.FAILED,
      failureReason: "card declined",
    });
    expect(r.invoice.amountPaid).toBe(0);
    expect(r.payment.failureReason).toBe("card declined");
  });

  it("refuses to pay a voided invoice", async () => {
    openInvoice({ status: InvoiceStatus.VOID });
    await expect(recordPayment({ invoiceId: "inv_1" })).rejects.toThrow(/voided/i);
  });

  it("refuses a non-positive amount", async () => {
    openInvoice();
    await expect(recordPayment({ invoiceId: "inv_1", amount: 0 })).rejects.toThrow(/greater than zero/i);
  });

  it("throws for an unknown invoice", async () => {
    await expect(recordPayment({ invoiceId: "nope" })).rejects.toThrow(/Invoice not found/i);
  });

  it("audits payment.recorded and invoice.paid, carrying the status", async () => {
    openInvoice();
    await recordPayment({ invoiceId: "inv_1", recordedByAdminId: "admin_7" });
    const recorded = auditEvents.find((e) => e.type === "payment.recorded")!;
    expect(recorded.actorId).toBe("admin_7");
    expect(recorded.actorType).toBe("ADMIN");
    expect(recorded.data.status).toBe(PaymentStatus.SUCCEEDED);
    expect(auditEvents.some((e) => e.type === "invoice.paid")).toBe(true);
  });

  it("a reactivation failure never fails the payment — the money is already committed", async () => {
    openInvoice();
    reactivateThrows = true;
    const r = await recordPayment({ invoiceId: "inv_1" });
    expect(r.settled).toBe(true);
    expect(r.invoice.status).toBe(InvoiceStatus.PAID);
  });
});

// ── transitionPayment ────────────────────────────────────────────────────────

describe("transitionPayment", () => {
  const pending = (over: Row = {}) => {
    const row = {
      id: "pay_1",
      hotelId: "hotel_1",
      invoiceId: "inv_1",
      status: PaymentStatus.PENDING,
      currency: "INR",
      amount: 249900,
      ...over,
    };
    payments.push(row);
    return row;
  };

  it("PENDING → SUCCEEDED credits the invoice and settles it", async () => {
    openInvoice();
    pending();
    const r = await transitionPayment({ paymentId: "pay_1", status: PaymentStatus.SUCCEEDED });
    expect(r.changed).toBe(true);
    expect(r.settled).toBe(true);
    expect(r.invoice!.status).toBe(InvoiceStatus.PAID);
    expect(r.invoice!.amountPaid).toBe(249900);
  });

  it("PENDING → SUCCEEDED reactivates, exactly like a directly-recorded payment", async () => {
    openInvoice();
    pending();
    await transitionPayment({ paymentId: "pay_1", status: PaymentStatus.SUCCEEDED });
    expect(reactivateCalls).toEqual([{ hotelId: "hotel_1", invoiceId: "inv_1" }]);
  });

  it("PENDING → FAILED records the reason and leaves the balance alone", async () => {
    const inv = openInvoice();
    pending();
    const r = await transitionPayment({
      paymentId: "pay_1",
      status: PaymentStatus.FAILED,
      failureReason: "UTR not found",
    });
    expect(r.payment.failureReason).toBe("UTR not found");
    expect(inv.amountPaid).toBe(0);
    expect(inv.status).toBe(InvoiceStatus.OPEN);
    expect(reactivateCalls).toHaveLength(0);
  });

  it("is idempotent — a redelivered webhook credits the invoice ONCE", async () => {
    const inv = openInvoice();
    pending();
    await transitionPayment({ paymentId: "pay_1", status: PaymentStatus.SUCCEEDED });
    const second = await transitionPayment({ paymentId: "pay_1", status: PaymentStatus.SUCCEEDED });
    expect(second.changed).toBe(false);
    expect(inv.amountPaid).toBe(249900);
    expect(reactivateCalls).toHaveLength(1);
  });

  it("refuses to move a payment out of a settled state into the other one", async () => {
    openInvoice();
    pending({ status: PaymentStatus.SUCCEEDED });
    await expect(
      transitionPayment({ paymentId: "pay_1", status: PaymentStatus.FAILED, failureReason: "x" }),
    ).rejects.toThrow(/Cannot transition/i);
  });

  it("refuses to credit a voided invoice", async () => {
    openInvoice({ status: InvoiceStatus.VOID });
    pending();
    await expect(
      transitionPayment({ paymentId: "pay_1", status: PaymentStatus.SUCCEEDED }),
    ).rejects.toThrow(/voided/i);
  });

  it("throws for an unknown payment", async () => {
    await expect(
      transitionPayment({ paymentId: "nope", status: PaymentStatus.SUCCEEDED }),
    ).rejects.toThrow(/Payment not found/i);
  });

  it("audits payment.succeeded / payment.failed", async () => {
    openInvoice();
    pending();
    await transitionPayment({ paymentId: "pay_1", status: PaymentStatus.SUCCEEDED, actorId: "admin_2" });
    const ev = auditEvents.find((e) => e.type === "payment.succeeded")!;
    expect(ev.actorId).toBe("admin_2");
    expect(ev.actorType).toBe("ADMIN");
  });

  it("emits no audit event when nothing changed", async () => {
    openInvoice();
    pending({ status: PaymentStatus.SUCCEEDED });
    await transitionPayment({ paymentId: "pay_1", status: PaymentStatus.SUCCEEDED });
    expect(auditEvents).toHaveLength(0);
  });
});

// ── outstandingBalance ───────────────────────────────────────────────────────

describe("outstandingBalance", () => {
  it("sums what is still owed across OPEN invoices only", async () => {
    openInvoice({ id: "a", total: 1000, amountPaid: 0 });
    openInvoice({ id: "b", total: 500, amountPaid: 200 });
    openInvoice({ id: "c", total: 900, amountPaid: 900, status: InvoiceStatus.PAID });
    expect(await outstandingBalance("hotel_1")).toBe(1300);
  });

  it("is zero when everything is settled", async () => {
    openInvoice({ id: "a", total: 1000, amountPaid: 1000, status: InvoiceStatus.PAID });
    expect(await outstandingBalance("hotel_1")).toBe(0);
  });

  it("never returns a negative balance from an overpaid invoice", async () => {
    openInvoice({ id: "a", total: 1000, amountPaid: 1500 });
    expect(await outstandingBalance("hotel_1")).toBe(0);
  });
});
