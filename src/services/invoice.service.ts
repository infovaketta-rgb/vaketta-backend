/**
 * invoice.service.ts
 *
 * Issues and settles invoices. This is the seam a payment gateway plugs into:
 * every invoice carries nullable `provider` / `providerInvoiceId`, and every
 * payment carries a unique `providerPaymentId`, so a future Razorpay/Stripe
 * webhook records a payment idempotently without a schema change.
 *
 * WHY THIS EXISTS
 * ---------------
 * `extraConversationCharge` / `extraAiReplyCharge` were snapshotted onto every
 * subscription and read by nothing — no invoice was ever produced, and the only
 * overage arithmetic in the product ran in the customer's browser as an
 * "estimate". Nothing recorded what a hotel actually owed.
 *
 * IDEMPOTENCY is structural, not defensive: `@@unique([hotelId, periodStart])`
 * means a re-run of the renewal cron, a restart mid-tick, or two instances
 * racing all converge on ONE invoice. `issueInvoice` catches P2002 and returns
 * the existing row rather than throwing.
 */
import { Prisma, InvoiceStatus, PaymentStatus } from "@prisma/client";
import prisma from "../db/connect";
import { logger } from "../utils/logger";
import { computeOverage, type OverageTerms, type UsageCounts } from "../billing/overage";
import { recordBillingEvent } from "./audit.service";

const log = logger.child({ service: "invoice" });

/** Days a hotel has to pay before the invoice is considered overdue. */
export const INVOICE_DUE_DAYS = 7;

export type LineItem = {
  kind: "subscription" | "overage_conversations" | "overage_ai_replies";
  description: string;
  quantity: number;
  /** Integer minor units per unit. */
  unitAmount: number;
  /** Integer minor units. quantity × unitAmount. */
  amount: number;
};

export type IssueInvoiceInput = {
  hotelId: string;
  subscriptionId: string | null;
  currency: string;
  /** The (possibly prorated) subscription charge, integer minor units. */
  subscriptionAmount: number;
  /** Usage accrued during the period being closed. */
  usage: UsageCounts;
  /** Snapshot terms the usage is measured against. */
  terms: OverageTerms;
  periodStart: Date;
  periodEnd: Date;
  /** Set when the charge is prorated, so the line item can say so. */
  prorated?: boolean;
  notes?: string;
};

/**
 * Sequential, human-facing invoice number: "INV-{year}-{00001}".
 *
 * Must be called inside a transaction holding the advisory lock below —
 * mirrors `generateReferenceNumber` in utils/booking.utils.ts, which solves the
 * identical problem for booking references.
 */
async function generateInvoiceNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const last = await tx.invoice.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const lastSeq = last?.number ? parseInt(last.number.split("-")[2] ?? "0", 10) : 0;
  return `${prefix}${String(lastSeq + 1).padStart(5, "0")}`;
}

/** Build the invoice's line items from the subscription charge + overage. */
export function buildLineItems(input: IssueInvoiceInput): { lineItems: LineItem[]; overageTotal: number } {
  const items: LineItem[] = [];

  if (input.subscriptionAmount > 0) {
    items.push({
      kind: "subscription",
      description: input.prorated
        ? "Subscription (prorated for a partial first period)"
        : "Subscription",
      quantity: 1,
      unitAmount: input.subscriptionAmount,
      amount: input.subscriptionAmount,
    });
  }

  const overage = computeOverage(input.usage, input.terms);

  if (overage.conversationOverage > 0 && overage.conversationCharge > 0) {
    items.push({
      kind: "overage_conversations",
      description: `Additional conversations (${overage.conversationOverage} over ${input.terms.conversationLimit})`,
      quantity: overage.conversationOverage,
      unitAmount: input.terms.extraConversationCharge,
      amount: overage.conversationCharge,
    });
  }

  if (overage.aiReplyOverage > 0 && overage.aiReplyCharge > 0) {
    items.push({
      kind: "overage_ai_replies",
      description: `Additional AI replies (${overage.aiReplyOverage} over ${input.terms.aiReplyLimit})`,
      quantity: overage.aiReplyOverage,
      unitAmount: input.terms.extraAiReplyCharge,
      amount: overage.aiReplyCharge,
    });
  }

  return { lineItems: items, overageTotal: overage.total };
}

/**
 * Issue an invoice for one closed billing period.
 *
 * Returns the existing invoice untouched if one already covers this period —
 * the renewal cron is safe to re-run. Pass `tx` to make issuing part of the
 * same atomic unit as the period roll.
 */
export async function issueInvoice(
  input: IssueInvoiceInput,
  tx?: Prisma.TransactionClient,
) {
  const run = async (db: Prisma.TransactionClient) => {
    const existing = await db.invoice.findUnique({
      where: { hotelId_periodStart: { hotelId: input.hotelId, periodStart: input.periodStart } },
    });
    if (existing) return existing;

    // Serialise number generation the same way booking references are.
    //
    // MUST be $executeRaw, not $queryRaw. `pg_advisory_xact_lock()` returns
    // `void`, and $queryRaw tries to deserialize the result set — which fails
    // with P2010 "Failed to deserialize column of type 'void'", aborting the
    // transaction before a single invoice row is written. That is why no
    // invoice had ever been created in production despite plans being assigned:
    // `assignPlanToHotel` swallowed the error, and `renewDueSubscriptions`
    // rolled the whole period back. $executeRaw runs the statement for its side
    // effect and returns a row count instead, which is what every other
    // advisory-lock call site here already does (booking.service.ts,
    // booking.controller.ts, flowRuntime.ts ×2). Lock semantics are identical.
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vaketta:invoice_number'))`;

    const { lineItems, overageTotal } = buildLineItems(input);
    const subtotal = Math.max(0, Math.round(input.subscriptionAmount));
    const total = subtotal + overageTotal;

    const dueAt = new Date(Date.now() + INVOICE_DUE_DAYS * 86_400_000);
    const number = await generateInvoiceNumber(db);

    try {
      return await db.invoice.create({
        data: {
          hotelId: input.hotelId,
          subscriptionId: input.subscriptionId,
          number,
          // A zero-total invoice (free trial, or a fully-included period) is
          // settled on creation — never dun a customer for nothing.
          status: total === 0 ? InvoiceStatus.PAID : InvoiceStatus.OPEN,
          currency: input.currency,
          subtotal,
          overageTotal,
          total,
          amountPaid: 0,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          dueAt,
          ...(total === 0 ? { paidAt: new Date() } : {}),
          lineItems: lineItems as unknown as Prisma.InputJsonValue,
          ...(input.notes ? { notes: input.notes } : {}),
        },
      });
    } catch (err) {
      // Lost a race with a concurrent tick — the other one's invoice is correct.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const winner = await db.invoice.findUnique({
          where: { hotelId_periodStart: { hotelId: input.hotelId, periodStart: input.periodStart } },
        });
        if (winner) return winner;
      }
      throw err;
    }
  };

  const invoice = tx ? await run(tx) : await prisma.$transaction(run);

  await recordBillingEvent("invoice.issued", {
    hotelId: input.hotelId,
    actorType: "SYSTEM",
    data: {
      invoiceId: invoice.id,
      number: invoice.number,
      total: invoice.total,
      currency: invoice.currency,
      periodStart: invoice.periodStart.toISOString(),
    },
  });

  return invoice;
}

export type RecordPaymentInput = {
  invoiceId: string;
  /** Integer minor units. Defaults to the invoice's outstanding balance. */
  amount?: number | undefined;
  method?: string | undefined;
  reference?: string | undefined;
  notes?: string | undefined;
  /** VakettaAdmin.id for a manual entry; omit for gateway-driven. */
  recordedByAdminId?: string | null | undefined;
  provider?: string | null | undefined;
  providerPaymentId?: string | null | undefined;
};

/**
 * Record a payment and settle the invoice when it is covered in full.
 *
 * Atomic: the payment row, the invoice's `amountPaid`, and the PAID transition
 * all land together, so a partially-applied payment can't leave an invoice
 * looking unpaid while the money row exists.
 */
export async function recordPayment(input: RecordPaymentInput) {
  const result = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({ where: { id: input.invoiceId } });
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status === InvoiceStatus.VOID) throw new Error("Cannot pay a voided invoice");

    const outstanding = Math.max(0, invoice.total - invoice.amountPaid);
    const amount = Math.round(input.amount ?? outstanding);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Payment amount must be greater than zero");

    const payment = await tx.payment.create({
      data: {
        hotelId: invoice.hotelId,
        invoiceId: invoice.id,
        status: PaymentStatus.SUCCEEDED,
        currency: invoice.currency,
        amount,
        method: input.method ?? "manual_bank_transfer",
        provider: input.provider ?? null,
        providerPaymentId: input.providerPaymentId ?? null,
        recordedByAdminId: input.recordedByAdminId ?? null,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      },
    });

    const amountPaid = invoice.amountPaid + amount;
    const settled = amountPaid >= invoice.total;

    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        amountPaid,
        ...(settled ? { status: InvoiceStatus.PAID, paidAt: new Date() } : {}),
      },
    });

    return { payment, invoice: updated, settled };
  });

  await recordBillingEvent("payment.recorded", {
    hotelId: result.invoice.hotelId,
    actorId: input.recordedByAdminId ?? null,
    actorType: input.recordedByAdminId ? "ADMIN" : "SYSTEM",
    data: {
      paymentId: result.payment.id,
      invoiceId: result.invoice.id,
      amount: result.payment.amount,
      currency: result.payment.currency,
      method: result.payment.method,
      settled: result.settled,
    },
  });

  if (result.settled) {
    await recordBillingEvent("invoice.paid", {
      hotelId: result.invoice.hotelId,
      actorType: "SYSTEM",
      data: { invoiceId: result.invoice.id, number: result.invoice.number },
    });
    log.info({ invoiceId: result.invoice.id, hotelId: result.invoice.hotelId }, "invoice settled");
  }

  return result;
}

/** Invoices for one hotel, newest first. Used by the hotel billing page. */
export async function listHotelInvoices(hotelId: string, limit = 24) {
  return prisma.invoice.findMany({
    where: { hotelId },
    orderBy: { periodStart: "desc" },
    take: Math.min(100, Math.max(1, limit)),
    include: { payments: { orderBy: { receivedAt: "desc" } } },
  });
}

/**
 * True when the hotel has an invoice that is overdue by more than `graceDays`.
 * Drives the PAST_DUE → EXPIRED transition in the billing cron.
 */
export async function findOverdueInvoices(now: Date, graceDays: number) {
  const cutoff = new Date(now.getTime() - Math.max(0, graceDays) * 86_400_000);
  return prisma.invoice.findMany({
    where: { status: InvoiceStatus.OPEN, dueAt: { lt: cutoff } },
    select: { id: true, hotelId: true, number: true, dueAt: true, total: true, currency: true },
  });
}

/** OPEN invoices already past due but still inside the grace window. */
export async function findJustOverdueInvoices(now: Date) {
  return prisma.invoice.findMany({
    where: { status: InvoiceStatus.OPEN, dueAt: { lt: now } },
    select: { id: true, hotelId: true, number: true, dueAt: true, total: true, currency: true },
  });
}
