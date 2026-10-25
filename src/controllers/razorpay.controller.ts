/**
 * controllers/razorpay.controller.ts
 *
 * The tenant-facing half of the Razorpay integration: open an order against an
 * invoice, and verify the checkout callback.
 *
 * MOUNT LOCATION IS LOAD-BEARING. These routes live under
 * `/hotel-settings/billing/*` because `requireActiveSubscription` exempts that
 * prefix from the 402 paywall for ALL methods, with the comment "Never gated,
 * whatever the method - this is how a customer pays us." Mounted anywhere else,
 * a SUSPENDED hotel - precisely the customer who most needs to pay - would be
 * 402'd out of paying. See settings.routes.ts.
 *
 * TRUST MODEL. The browser supplies exactly two things: which invoice it wants
 * to pay, and a signed callback. It never supplies an amount, a currency, a
 * hotel id, or a payment status:
 *   • the amount is derived from `invoice.total - invoice.amountPaid`;
 *   • the hotel comes from the JWT and is checked against `invoice.hotelId`;
 *   • the callback is re-verified with KEY_SECRET before anything is credited.
 */
import { Request, Response } from "express";
import { InvoiceStatus } from "@prisma/client";
import prisma from "../db/connect";
import {
  createRazorpayOrder,
  verifyCheckoutSignature,
  RazorpayNotConfiguredError,
  RazorpayApiError,
} from "../services/razorpay.service";
import { settleRazorpayPayment } from "../services/razorpayPayment.service";
import { recordBillingEvent } from "../services/audit.service";
import {
  getRazorpayConfig,
  isRazorpayEnabled,
  isSupportedCurrency,
} from "../config/razorpay.config";
import { serverError } from "../utils/serverError";
import { logger } from "../utils/logger";

const log = logger.child({ service: "razorpay-controller" });

function hotelId(req: Request): string {
  return (req as any).user.hotelId;
}

/**
 * POST /hotel-settings/billing/invoices/:invoiceId/razorpay-order
 *
 * Opens (or re-uses) a Razorpay Order for an OPEN invoice.
 *
 * NO Payment ROW IS CREATED HERE. An order is an intent to pay, not a payment;
 * a row at this point would be a claim on money that may never arrive, and
 * would have to be reconciled away for every abandoned checkout.
 */
export async function createInvoiceOrderHandler(req: Request, res: Response) {
  const invoiceId = req.params["invoiceId"]!;
  const hid = hotelId(req);

  if (!isRazorpayEnabled()) {
    return res.status(503).json({ error: "Online payment is currently unavailable." });
  }

  const config = getRazorpayConfig();
  if (!config) {
    log.warn("razorpay order requested but no credentials are configured");
    return res.status(503).json({ error: "Online payment is not configured." });
  }

  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });

    // IDOR GUARD. A 404 (not a 403) for another tenant's invoice - an existence
    // oracle would let one hotel enumerate another's invoice ids.
    if (!invoice || invoice.hotelId !== hid) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    if (invoice.status === InvoiceStatus.VOID) {
      return res.status(400).json({ error: "This invoice has been voided." });
    }
    if (invoice.status === InvoiceStatus.PAID) {
      return res.status(400).json({ error: "This invoice is already paid." });
    }

    const outstanding = Math.max(0, invoice.total - invoice.amountPaid);
    if (outstanding <= 0) {
      return res.status(400).json({ error: "This invoice has nothing outstanding." });
    }

    // Stage 2B is INR-only. A USD plan must not silently be charged in rupees.
    if (!isSupportedCurrency(invoice.currency)) {
      return res.status(400).json({
        error: `Online payment is currently available for INR invoices only (this invoice is in ${invoice.currency}).`,
      });
    }

    // ── Re-use before create ──────────────────────────────────────────────
    // `Invoice.providerOrderId` is @unique, and a Razorpay order stays valid
    // until it is paid, so re-opening checkout after an abandonment must return
    // the SAME order rather than trying (and failing) to create a second one.
    if (invoice.providerOrderId) {
      return res.json({
        orderId: invoice.providerOrderId,
        amount: outstanding,
        currency: invoice.currency,
        keyId: config.keyId,
        invoiceNumber: invoice.number,
        reused: true,
      });
    }

    const order = await createRazorpayOrder({
      amount: outstanding,
      currency: invoice.currency,
      receipt: invoice.number,
      notes: { invoiceId: invoice.id, hotelId: invoice.hotelId, invoiceNumber: invoice.number },
    });

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { provider: "razorpay", providerOrderId: order.id },
    });

    await recordBillingEvent("payment.gateway_order_created", {
      hotelId: invoice.hotelId,
      actorType: "SYSTEM",
      data: {
        invoiceId: invoice.id,
        orderId: order.id,
        amount: outstanding,
        currency: invoice.currency,
      },
    });

    log.info({ invoiceId: invoice.id, orderId: order.id }, "razorpay order created");

    return res.json({
      orderId: order.id,
      amount: outstanding,
      currency: invoice.currency,
      // Publishable key, returned per-request so switching test<->live needs no
      // frontend rebuild. The SECRET never appears in any response.
      keyId: config.keyId,
      invoiceNumber: invoice.number,
      reused: false,
    });
  } catch (err) {
    if (err instanceof RazorpayNotConfiguredError) {
      return res.status(503).json({ error: "Online payment is not configured." });
    }
    if (err instanceof RazorpayApiError) {
      return res.status(502).json({ error: `Payment provider error: ${err.message}` });
    }
    if (err instanceof Error && /LIVE key/i.test(err.message)) {
      log.error("refusing to create an order with a live key while in test-mode-only stage");
      return res.status(503).json({ error: "Online payment is not configured for this environment." });
    }
    return serverError(res, err, "Failed to start payment");
  }
}

/**
 * POST /hotel-settings/billing/razorpay/verify
 *
 * The checkout success callback. A LATENCY OPTIMISATION, not the authority:
 * the webhook settles the same payment independently, so a user who closes the
 * tab mid-redirect is still credited. Both converge on `settleRazorpayPayment`.
 */
export async function verifyRazorpayPaymentHandler(req: Request, res: Response) {
  const hid = hotelId(req);
  const orderId = String(req.body?.razorpay_order_id ?? "");
  const paymentId = String(req.body?.razorpay_payment_id ?? "");
  const signature = String(req.body?.razorpay_signature ?? "");

  if (!orderId || !paymentId || !signature) {
    return res.status(400).json({ error: "Incomplete payment confirmation." });
  }

  try {
    // ── Signature first, before any lookup ────────────────────────────────
    if (!verifyCheckoutSignature({ orderId, paymentId, signature })) {
      log.warn({ orderId, hotelId: hid }, "razorpay checkout signature verification FAILED");
      return res.status(400).json({ error: "Payment could not be verified." });
    }

    const invoice = await prisma.invoice.findUnique({
      where: { providerOrderId: orderId },
      select: { id: true, hotelId: true, total: true, amountPaid: true, currency: true },
    });

    // IDOR GUARD on the settlement path too: a signature proves Razorpay saw
    // this payment, NOT that the caller owns the invoice it belongs to.
    if (!invoice || invoice.hotelId !== hid) {
      log.warn({ orderId, hotelId: hid }, "verified razorpay payment for a foreign/unknown order");
      return res.status(404).json({ error: "Order not found" });
    }

    // The amount is re-derived here rather than read from the request body.
    const outstanding = Math.max(0, invoice.total - invoice.amountPaid);

    const result = await settleRazorpayPayment({
      orderId,
      paymentId,
      amount: outstanding,
      currency: invoice.currency,
      source: "checkout_callback",
      method: req.body?.method ? String(req.body.method).slice(0, 20) : null,
    });

    if (!result.ok) {
      return res.status(400).json({ error: settlementErrorMessage(result.reason), code: result.reason });
    }

    return res.json({
      status: result.outcome === "already_processed" ? "already_processed" : "success",
      invoiceId: result.invoiceId,
    });
  } catch (err) {
    return serverError(res, err, "Failed to confirm payment");
  }
}

function settlementErrorMessage(reason: string): string {
  switch (reason) {
    case "invoice_void":
      return "This invoice was voided. Please contact support - your payment needs to be refunded.";
    case "invoice_already_paid":
      return "This invoice is already paid.";
    case "amount_mismatch":
      return "The payment amount did not match the invoice. Please contact support.";
    case "currency_mismatch":
      return "The payment currency did not match the invoice. Please contact support.";
    case "unknown_order":
      return "Order not found.";
    default:
      return "The payment could not be applied.";
  }
}
