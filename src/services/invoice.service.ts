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
  kind: "subscription" | "overage_conversations" | "overage_ai_replies" | "tax";
  description: string;
  quantity: number;
  /** Integer minor units per unit. */
  unitAmount: number;
  /** Integer minor units. quantity × unitAmount. */
  amount: number;
};

/**
 * Tax on a taxable base, in integer minor units.
 *
 * `rateBp` is BASIS POINTS (1800 = 18%). Percentages are not stored as floats
 * anywhere in this codebase: `base * 0.18` reintroduces exactly the drift the
 * money columns were migrated from Float to Int to eliminate. Staying in
 * integers and rounding once, at the end, is the whole point.
 *
 * Exported and pure so the invoice generator and any future checkout quote
 * compute the same number — the same one-writer rule `computeOverage` follows.
 */
export function computeTax(base: number, rateBp: unknown): number {
  const bp = typeof rateBp === "number" && Number.isFinite(rateBp) && rateBp > 0 ? Math.floor(rateBp) : 0;
  if (bp === 0) return 0;
  const taxable = Number.isFinite(base) && base > 0 ? Math.round(base) : 0;
  return Math.round((taxable * bp) / 10_000);
}

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
  /**
   * Tax rate in basis points, snapshotted onto the invoice. Omitted/0 = no tax,
   * which is what every caller does today, so totals are unchanged until a
   * superadmin sets a rate on a Plan.
   */
  taxRate?: number | undefined;
  taxLabel?: string | null | undefined;
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

/**
 * Build the invoice's line items from the subscription charge + overage + tax.
 *
 * Returns the tax figures alongside so `issueInvoice` never recomputes them —
 * one calculation, one set of numbers on the row and on the line items.
 */
export function buildLineItems(input: IssueInvoiceInput): {
  lineItems: LineItem[];
  overageTotal: number;
  taxTotal: number;
  taxRate: number;
} {
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

  // Tax applies to the whole taxable base — subscription plus overage — not to
  // the subscription alone, so a hotel that overruns its allowance is taxed on
  // what it actually owes.
  const subscriptionAmount = Math.max(0, Math.round(input.subscriptionAmount));
  const taxRate = typeof input.taxRate === "number" && input.taxRate > 0 ? Math.floor(input.taxRate) : 0;
  const taxTotal = computeTax(subscriptionAmount + overage.total, taxRate);

  if (taxTotal > 0) {
    items.push({
      kind: "tax",
      description: input.taxLabel || `Tax (${(taxRate / 100).toFixed(2).replace(/\.00$/, "")}%)`,
      quantity: 1,
      unitAmount: taxTotal,
      amount: taxTotal,
    });
  }

  return { lineItems: items, overageTotal: overage.total, taxTotal, taxRate };
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

    const { lineItems, overageTotal, taxTotal, taxRate } = buildLineItems(input);
    const subtotal = Math.max(0, Math.round(input.subscriptionAmount));
    // Reduces to the pre-tax formula exactly when taxTotal is 0, which is every
    // invoice until a superadmin sets a rate — so no historical total changes.
    const total = subtotal + overageTotal + taxTotal;

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
          taxTotal,
          taxRate,
          ...(input.taxLabel ? { taxLabel: input.taxLabel } : {}),
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
  providerOrderId?: string | null | undefined;
  /**
   * Defaults to SUCCEEDED, which is what the admin "record payment" action has
   * always meant: a human confirming money has arrived. A gateway or offline
   * intake path passes PENDING and later calls `transitionPayment`.
   *
   * This was previously HARDCODED to SUCCEEDED, which made PENDING and FAILED
   * unreachable and meant a row's existence was synonymous with money received.
   */
  status?: PaymentStatus | undefined;
  failureReason?: string | null | undefined;
};

/**
 * Apply a SUCCEEDED payment's amount to its invoice, settling it when covered.
 *
 * The ONE place `amountPaid` moves and the ONE place an invoice becomes PAID.
 * Both `recordPayment` (money confirmed up front) and `transitionPayment`
 * (PENDING → SUCCEEDED later) route through here, so the two paths cannot drift
 * apart on rounding, on the settled threshold, or on stamping `paidAt`.
 *
 * PENDING and FAILED payments deliberately do NOT reach this function — an
 * unverified or failed payment must never count toward a balance.
 */
async function applyPaymentToInvoice(
  tx: Prisma.TransactionClient,
  invoice: { id: string; total: number; amountPaid: number },
  amount: number,
): Promise<{ invoice: Awaited<ReturnType<typeof tx.invoice.update>>; settled: boolean }> {
  const amountPaid = invoice.amountPaid + amount;
  const settled = amountPaid >= invoice.total;

  const updated = await tx.invoice.update({
    where: { id: invoice.id },
    data: {
      amountPaid,
      ...(settled ? { status: InvoiceStatus.PAID, paidAt: new Date() } : {}),
    },
  });

  return { invoice: updated, settled };
}

/**
 * Restore service after money lands. **This is the P0 fix.**
 *
 * Settling an invoice used to change nothing outside the Invoice and Payment
 * tables: `Hotel.subscriptionStatus`, `Subscription.status` and the Redis
 * entitlement cache were all left exactly as they were. Because
 * `resolveEffectiveState` treats EXPIRED as terminal, a hotel suspended by
 * dunning for non-payment **stayed suspended after paying that very invoice** —
 * while the dunning email it had just received promised "Settle the invoice to
 * resume immediately". The only recovery available to support was to re-assign
 * the plan, which issues a SECOND full-price invoice and moves the customer's
 * billing anchor.
 *
 * Imported dynamically to break the `invoice.service ⇄ billing.service` cycle
 * (billing.service imports `issueInvoice` at module load). This is the existing
 * house pattern — `dunning.service` reaches for `invalidateSubscriptionStatusCache`
 * the same way.
 *
 * Never throws: the money is already recorded and committed, and a failure to
 * reactivate must surface as a log line plus a support ticket, not as a 500 that
 * makes the caller think the payment itself failed.
 */
async function reactivateAfterSettlement(hotelId: string, invoiceId: string): Promise<void> {
  try {
    const { reactivateAfterPayment } = await import("./billing.service");
    await reactivateAfterPayment(hotelId, { invoiceId });
  } catch (err) {
    log.error({ err, hotelId, invoiceId }, "invoice settled but reactivation failed — hotel may still be suspended");
  }
}

/**
 * Record a payment and settle the invoice when it is covered in full.
 *
 * Atomic: the payment row, the invoice's `amountPaid`, and the PAID transition
 * all land together, so a partially-applied payment can't leave an invoice
 * looking unpaid while the money row exists.
 *
 * Reactivation happens AFTER the transaction commits, deliberately: it writes to
 * Hotel and Subscription and clears a Redis key, and none of that should be able
 * to roll back a recorded payment.
 */
export async function recordPayment(input: RecordPaymentInput) {
  const status = input.status ?? PaymentStatus.SUCCEEDED;

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
        status,
        currency: invoice.currency,
        amount,
        method: input.method ?? "manual_bank_transfer",
        provider: input.provider ?? null,
        providerPaymentId: input.providerPaymentId ?? null,
        providerOrderId: input.providerOrderId ?? null,
        recordedByAdminId: input.recordedByAdminId ?? null,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        failureReason: input.failureReason ?? null,
      },
    });

    // Only money that has actually arrived moves the balance. A PENDING row is
    // a claim, not a payment; a FAILED row is a record of an attempt.
    if (status !== PaymentStatus.SUCCEEDED) {
      return { payment, invoice, settled: false };
    }

    const applied = await applyPaymentToInvoice(tx, invoice, amount);
    return { payment, invoice: applied.invoice, settled: applied.settled };
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
      status: result.payment.status,
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
    await reactivateAfterSettlement(result.invoice.hotelId, result.invoice.id);
  }

  return result;
}

/**
 * The only statuses reachable from PENDING.
 *
 * `Extract` off the generated union rather than a hand-written string literal,
 * so renaming or removing an enum member breaks this at compile time. Prisma
 * generates `PaymentStatus` as a const object plus a union type, not a TS enum,
 * so `PaymentStatus.SUCCEEDED` is a value and cannot appear in type position.
 */
export type SettledPaymentStatus = Extract<PaymentStatus, "SUCCEEDED" | "FAILED">;

export type TransitionPaymentInput = {
  paymentId: string;
  /** Only SUCCEEDED and FAILED are reachable from PENDING. */
  status: SettledPaymentStatus;
  failureReason?: string | null | undefined;
  /** VakettaAdmin.id when a human approved/rejected it. */
  actorId?: string | null | undefined;
};

/**
 * Move a PENDING payment to SUCCEEDED or FAILED.
 *
 * The transition a gateway webhook or (later) an admin verification decision
 * drives. Settling here reuses `applyPaymentToInvoice`, so a payment confirmed
 * asynchronously credits its invoice identically to one recorded as confirmed
 * up front, and triggers the same reactivation.
 *
 * IDEMPOTENT. Re-applying a transition that already happened returns
 * `{ changed: false }` without touching the balance — the claim is staked with
 * `updateMany … where status = PENDING`, so two concurrent webhook deliveries
 * cannot both credit the invoice. Same atomic-claim shape as
 * `executeDelayedSend`'s `PENDING → SENT` guard in message.service.
 */
export async function transitionPayment(input: TransitionPaymentInput) {
  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: input.paymentId } });
    if (!payment) throw new Error("Payment not found");

    // Already in the target state — a redelivered webhook, not an error.
    if (payment.status === input.status) return { payment, invoice: null, settled: false, changed: false };
    if (payment.status !== PaymentStatus.PENDING) {
      throw new Error(`Cannot transition a ${payment.status} payment`);
    }

    // Atomic claim: only ONE caller can move this row out of PENDING.
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: {
        status: input.status,
        ...(input.status === PaymentStatus.FAILED
          ? { failureReason: input.failureReason ?? null }
          : { receivedAt: new Date() }),
      },
    });
    if (claimed.count === 0) {
      return { payment, invoice: null, settled: false, changed: false };
    }

    const updatedPayment = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });

    if (input.status === PaymentStatus.FAILED) {
      return { payment: updatedPayment, invoice: null, settled: false, changed: true };
    }

    const invoice = await tx.invoice.findUnique({ where: { id: payment.invoiceId } });
    if (!invoice) throw new Error("Invoice not found");
    // A voided invoice must not be credited — the money needs refunding, which
    // is a separate (P2) flow. Surfacing this loudly beats silently crediting.
    if (invoice.status === InvoiceStatus.VOID) throw new Error("Cannot pay a voided invoice");

    const applied = await applyPaymentToInvoice(tx, invoice, updatedPayment.amount);
    return { payment: updatedPayment, invoice: applied.invoice, settled: applied.settled, changed: true };
  });

  if (!result.changed) return result;

  await recordBillingEvent(
    input.status === PaymentStatus.SUCCEEDED ? "payment.succeeded" : "payment.failed",
    {
      hotelId: result.payment.hotelId,
      actorId: input.actorId ?? null,
      actorType: input.actorId ? "ADMIN" : "SYSTEM",
      data: {
        paymentId: result.payment.id,
        invoiceId: result.payment.invoiceId,
        amount: result.payment.amount,
        currency: result.payment.currency,
        settled: result.settled,
        ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      },
    },
  );

  if (result.settled && result.invoice) {
    await recordBillingEvent("invoice.paid", {
      hotelId: result.invoice.hotelId,
      actorType: "SYSTEM",
      data: { invoiceId: result.invoice.id, number: result.invoice.number },
    });
    log.info({ invoiceId: result.invoice.id, hotelId: result.invoice.hotelId }, "invoice settled");
    await reactivateAfterSettlement(result.invoice.hotelId, result.invoice.id);
  }

  return result;
}

/**
 * Money still owed by a hotel, in minor units, across all OPEN invoices.
 *
 * Drives the reactivation gate: paying ONE of three overdue invoices must not
 * restore service. Counted from `total - amountPaid` rather than from Payment
 * rows so PENDING (unverified) payments correctly still read as outstanding.
 */
export async function outstandingBalance(hotelId: string): Promise<number> {
  const open = await prisma.invoice.findMany({
    where: { hotelId, status: InvoiceStatus.OPEN },
    select: { total: true, amountPaid: true },
  });
  return open.reduce((sum, inv) => sum + Math.max(0, inv.total - inv.amountPaid), 0);
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
