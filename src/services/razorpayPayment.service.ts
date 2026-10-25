/**
 * services/razorpayPayment.service.ts
 *
 * THE CONVERGENCE POINT. Both ways a Razorpay payment can reach us - the
 * browser checkout callback and the server-to-server webhook - land in
 * `settleRazorpayPayment`, which is the only function in the Razorpay
 * integration allowed to move money.
 *
 * WHY ONE FUNCTION: the callback is fast but untrustworthy-by-default and can
 * be lost (the user closes the tab mid-redirect); the webhook is authoritative
 * but arrives seconds later. Both fire for the same payment in the normal case.
 * If each had its own settlement path they would inevitably drift on rounding,
 * on the "already processed" check, or on which failure is fatal - and a
 * double-credit is the worst bug this system can have. One function, one set of
 * guards, called twice, second call a no-op.
 *
 * THIS IS NOT A NEW SETTLEMENT PATH. It validates, then delegates to
 * `recordPayment`, which is the existing single writer: it creates the Payment
 * row and calls `applyPaymentToInvoice` -> `reactivateAfterSettlement` ->
 * `reactivateAfterPayment` -> `invalidateSubscriptionStatusCache`. Every P0
 * guarantee (atomicity, the settled threshold, reactivation, cache-busting)
 * applies unchanged and untouched.
 *
 * TENANT SAFETY: the hotel is ALWAYS derived from a local
 * `Invoice.providerOrderId` lookup, never from Razorpay's `notes` (which we
 * write, but which are attacker-influencable in principle and must never be
 * authoritative). A caller cannot name the invoice or the hotel.
 *
 * IDEMPOTENCY, in three layers:
 *   1. pre-check on `Payment.providerPaymentId` (the common case);
 *   2. `Payment.providerPaymentId @unique` + a P2002 catch (the true race, when
 *      callback and webhook arrive within milliseconds of each other);
 *   3. the invoice's own PAID/VOID state.
 *
 * MULTI-ATTEMPT ORDERS: Razorpay issues a DISTINCT `pay_*` per attempt but
 * reuses one `order_*`. `providerOrderId` is therefore deliberately NOT written
 * onto Payment rows - doing so would make a failed attempt's row collide with
 * the successful retry on `Payment.providerOrderId @unique` and block the
 * payment. The order id lives on the Invoice (where it is genuinely 1:1) and
 * `providerPaymentId` identifies the attempt.
 */
import { InvoiceStatus, Prisma } from "@prisma/client";
import prisma from "../db/connect";
import { recordPayment } from "./invoice.service";
import { recordBillingEvent } from "./audit.service";
import { isSupportedCurrency } from "../config/razorpay.config";
import { logger } from "../utils/logger";

const log = logger.child({ service: "razorpay-payment" });

export type SettleSource = "checkout_callback" | "webhook";

export type SettleInput = {
  /** Razorpay order id - the ONLY link back to a local invoice. */
  orderId: string;
  /** Razorpay payment id (`pay_*`) - unique per attempt, our idempotency key. */
  paymentId: string;
  /** Amount Razorpay reports, in minor units. Cross-checked, never trusted. */
  amount: number;
  currency: string;
  source: SettleSource;
  /** Razorpay's payment method string ("card", "upi", ...) when known. */
  method?: string | null;
};

export type SettleResult =
  | { ok: true; outcome: "settled" | "partial"; invoiceId: string; paymentId: string }
  | { ok: true; outcome: "already_processed"; invoiceId: string | null; paymentId: string }
  | {
      ok: false;
      reason:
        | "unknown_order"
        | "invoice_void"
        | "invoice_already_paid"
        | "amount_mismatch"
        | "currency_mismatch"
        | "invalid_amount";
      invoiceId: string | null;
    };

/**
 * Convert a confirmed-successful Razorpay payment into a Vaketta payment.
 *
 * Callers MUST have verified a signature before calling this - it performs no
 * cryptography of its own. It assumes "Razorpay says this succeeded" and asks
 * only "does that match an invoice we are owed money on".
 */
export async function settleRazorpayPayment(input: SettleInput): Promise<SettleResult> {
  const { orderId, paymentId, amount, currency, source } = input;

  // ── Layer 1: has this exact attempt already been recorded? ────────────────
  const existing = await prisma.payment.findUnique({
    where: { providerPaymentId: paymentId },
    select: { id: true, invoiceId: true },
  });
  if (existing) {
    log.info({ paymentId, source }, "razorpay payment already recorded - no-op");
    return { ok: true, outcome: "already_processed", invoiceId: existing.invoiceId, paymentId };
  }

  // ── Resolve the invoice LOCALLY. Never from webhook notes. ────────────────
  const invoice = await prisma.invoice.findUnique({
    where: { providerOrderId: orderId },
    select: {
      id: true,
      hotelId: true,
      status: true,
      currency: true,
      total: true,
      amountPaid: true,
      number: true,
    },
  });

  if (!invoice) {
    // Not necessarily an attack: an order created against another environment
    // sharing the same Razorpay test account looks exactly like this.
    log.warn({ orderId, source }, "razorpay payment for an unknown order - ignoring");
    return { ok: false, reason: "unknown_order", invoiceId: null };
  }

  if (invoice.status === InvoiceStatus.VOID) {
    log.error(
      { orderId, invoiceId: invoice.id, hotelId: invoice.hotelId },
      "razorpay payment received for a VOIDED invoice - needs manual refund",
    );
    await safeAudit("payment.gateway_rejected", invoice.hotelId, {
      reason: "invoice_void",
      invoiceId: invoice.id,
      orderId,
      paymentId,
      source,
    });
    return { ok: false, reason: "invoice_void", invoiceId: invoice.id };
  }

  if (invoice.status === InvoiceStatus.PAID) {
    log.warn({ orderId, invoiceId: invoice.id }, "razorpay payment for an already-paid invoice");
    return { ok: false, reason: "invoice_already_paid", invoiceId: invoice.id };
  }

  if (invoice.currency.toUpperCase() !== currency.toUpperCase() || !isSupportedCurrency(currency)) {
    log.error(
      { orderId, invoiceId: invoice.id, invoiceCurrency: invoice.currency, paidCurrency: currency },
      "razorpay currency does not match the invoice",
    );
    await safeAudit("payment.gateway_rejected", invoice.hotelId, {
      reason: "currency_mismatch",
      invoiceId: invoice.id,
      orderId,
      paymentId,
      expected: invoice.currency,
      received: currency,
      source,
    });
    return { ok: false, reason: "currency_mismatch", invoiceId: invoice.id };
  }

  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: "invalid_amount", invoiceId: invoice.id };
  }

  // ── Amount cross-check ────────────────────────────────────────────────────
  // The order was created for exactly the outstanding balance. If Razorpay
  // reports a different figure, something is wrong (a tampered checkout, a
  // partially-refunded payment, or a stale order after another payment landed)
  // and crediting it would corrupt the ledger. Overpayment is rejected too:
  // silently accepting more money than is owed creates a credit balance this
  // system has no concept of.
  const outstanding = Math.max(0, invoice.total - invoice.amountPaid);
  if (amount !== outstanding) {
    log.error(
      { orderId, invoiceId: invoice.id, expected: outstanding, received: amount, source },
      "razorpay amount does not match the outstanding invoice balance - refusing to settle",
    );
    await safeAudit("payment.gateway_rejected", invoice.hotelId, {
      reason: "amount_mismatch",
      invoiceId: invoice.id,
      orderId,
      paymentId,
      expected: outstanding,
      received: amount,
      source,
    });
    return { ok: false, reason: "amount_mismatch", invoiceId: invoice.id };
  }

  // ── Delegate to the EXISTING single settlement writer ─────────────────────
  try {
    const result = await recordPayment({
      invoiceId: invoice.id,
      amount,
      method: input.method ? `razorpay_${input.method}` : "razorpay",
      status: "SUCCEEDED",
      provider: "razorpay",
      providerPaymentId: paymentId,
      // providerOrderId deliberately omitted - see the file header.
      reference: orderId,
      recordedByAdminId: null,
    });

    await safeAudit("payment.gateway_verified", invoice.hotelId, {
      invoiceId: invoice.id,
      orderId,
      paymentId,
      amount,
      currency,
      source,
      settled: result.settled,
    });

    log.info(
      { invoiceId: invoice.id, hotelId: invoice.hotelId, paymentId, source, settled: result.settled },
      "razorpay payment recorded",
    );

    return {
      ok: true,
      outcome: result.settled ? "settled" : "partial",
      invoiceId: invoice.id,
      paymentId,
    };
  } catch (err) {
    // ── Layer 2: the genuine race ──────────────────────────────────────────
    // Callback and webhook arriving together both pass the layer-1 pre-check,
    // then one loses on `Payment.providerPaymentId @unique`. That is a success,
    // not a failure: the other caller credited the invoice.
    if (isDuplicatePaymentError(err)) {
      log.info({ paymentId, source }, "razorpay payment raced - already recorded by the other path");
      return { ok: true, outcome: "already_processed", invoiceId: invoice.id, paymentId };
    }
    throw err;
  }
}

/**
 * Record a failed Razorpay attempt.
 *
 * AUDIT ONLY - deliberately no Payment row. The existing P0 semantics are
 * "PENDING is a claim, FAILED is a record of an attempt"; a declined card is
 * not a claim on money, and writing a row would also collide with the eventual
 * successful retry (see the multi-attempt note in the file header). The audit
 * log is the correct home for "someone tried and it did not work".
 */
export async function recordRazorpayFailure(input: {
  orderId: string;
  paymentId: string;
  reason?: string | null;
  method?: string | null;
}): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { providerOrderId: input.orderId },
    select: { id: true, hotelId: true },
  });

  if (!invoice) {
    log.warn({ orderId: input.orderId }, "failed razorpay payment for an unknown order - ignoring");
    return;
  }

  await safeAudit("payment.failed", invoice.hotelId, {
    invoiceId: invoice.id,
    orderId: input.orderId,
    paymentId: input.paymentId,
    provider: "razorpay",
    ...(input.method ? { method: input.method } : {}),
    ...(input.reason ? { failureReason: input.reason } : {}),
  });

  log.info({ invoiceId: invoice.id, paymentId: input.paymentId }, "razorpay payment failed");
}

function isDuplicatePaymentError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002" &&
    String(err.meta?.["target"] ?? "").includes("providerPaymentId")
  );
}

/** Audit writes are best-effort; money already moved. Mirrors audit.service. */
async function safeAudit(
  type: Parameters<typeof recordBillingEvent>[0],
  hotelId: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await recordBillingEvent(type, {
      hotelId,
      actorType: "SYSTEM",
      data: data as Prisma.InputJsonValue,
    });
  } catch (err) {
    log.error({ err, type, hotelId }, "failed to record razorpay audit event");
  }
}
