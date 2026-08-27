/**
 * adminBilling.controller.ts
 *
 * Superadmin-facing invoice, payment and audit endpoints. None of this existed:
 * billing was entirely manual with no record of what was owed or collected, and
 * the only "audit trail" was a `console.info` in the browser.
 */
import { Request, Response } from "express";
import { InvoiceStatus, PaymentStatus, Prisma } from "@prisma/client";
import prisma from "../db/connect";
import { recordPayment, transitionPayment, type SettledPaymentStatus } from "../services/invoice.service";
import { listAuditLog, recordBillingEvent } from "../services/audit.service";
import { serverError } from "../utils/serverError";
import { parseMinorAmount, parseNonEmptyString } from "../billing/validate";

const adminId = (req: Request): string | null => (req as any).vakettaAdmin?.id ?? null;

// GET /admin/invoices?hotelId=&status=&page=&limit=
export async function listInvoicesHandler(req: Request, res: Response) {
  try {
    const page = Math.max(1, Number(req.query["page"]) || 1);
    const limit = Math.min(100, Number(req.query["limit"]) || 25);
    const status = String(req.query["status"] ?? "").toUpperCase();
    const hotelId = req.query["hotelId"] ? String(req.query["hotelId"]) : undefined;

    const where: Prisma.InvoiceWhereInput = {
      ...(hotelId ? { hotelId } : {}),
      ...(status && status in InvoiceStatus ? { status: status as InvoiceStatus } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: { issuedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          hotel: { select: { id: true, name: true } },
          payments: { orderBy: { receivedAt: "desc" } },
        },
      }),
      prisma.invoice.count({ where }),
    ]);

    res.json({ data, total, page, pages: Math.ceil(total / limit), limit });
  } catch (err) {
    return serverError(res, err, "Failed to fetch invoices");
  }
}

// POST /admin/invoices/:id/payments — record a manual payment
export async function recordPaymentHandler(req: Request, res: Response) {
  const invoiceId = req.params["id"]!;
  const b = req.body ?? {};

  // Omitted amount means "paid in full" — recordPayment resolves the balance.
  let amount: number | undefined;
  if (b.amount != null) {
    const parsed = parseMinorAmount(b.amount, "amount");
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (parsed.value === 0) return res.status(400).json({ error: "amount must be greater than zero." });
    amount = parsed.value;
  }

  let method = "manual_bank_transfer";
  if (b.method != null) {
    const parsed = parseNonEmptyString(b.method, "method", 40);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    method = parsed.value;
  }

  // Defaults to SUCCEEDED — an admin recording a payment is asserting the money
  // arrived, which is what this action has always meant. PENDING is now
  // expressible so a payment awaiting verification can be logged without
  // crediting the invoice.
  let status: PaymentStatus = PaymentStatus.SUCCEEDED;
  if (b.status != null) {
    const s = String(b.status).toUpperCase();
    if (s !== PaymentStatus.SUCCEEDED && s !== PaymentStatus.PENDING) {
      return res.status(400).json({ error: "status must be SUCCEEDED or PENDING." });
    }
    status = s as PaymentStatus;
  }

  try {
    const result = await recordPayment({
      invoiceId,
      ...(amount !== undefined ? { amount } : {}),
      method,
      status,
      reference: b.reference ? String(b.reference).slice(0, 120) : undefined,
      notes: b.notes ? String(b.notes).slice(0, 500) : undefined,
      recordedByAdminId: adminId(req),
    });
    res.status(201).json(result);
  } catch (err) {
    // Business refusals from the writer are the CALLER's fault, not ours —
    // surfacing them as 500s would hide "you tried to over-credit this invoice"
    // behind a generic server error.
    if (
      err instanceof Error &&
      /not found|voided|greater than zero|exceeds the outstanding|already paid/i.test(err.message)
    ) {
      return res.status(400).json({ error: err.message });
    }
    return serverError(res, err, "Failed to record payment");
  }
}

/**
 * POST /admin/payments/:id/transition — move a PENDING payment to SUCCEEDED or FAILED.
 *
 * The admin-side primitive behind `PaymentStatus`'s lifecycle. A gateway webhook
 * will later drive the same `transitionPayment` service function, which is why
 * settlement and reactivation live there rather than here.
 */
export async function transitionPaymentHandler(req: Request, res: Response) {
  const paymentId = req.params["id"]!;
  const raw = String(req.body?.status ?? "").toUpperCase();

  if (raw !== PaymentStatus.SUCCEEDED && raw !== PaymentStatus.FAILED) {
    return res.status(400).json({ error: "status must be SUCCEEDED or FAILED." });
  }

  let failureReason: string | undefined;
  if (raw === PaymentStatus.FAILED) {
    const parsed = parseNonEmptyString(req.body?.failureReason, "failureReason", 500);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    failureReason = parsed.value;
  }

  try {
    const result = await transitionPayment({
      paymentId,
      status: raw as SettledPaymentStatus,
      ...(failureReason !== undefined ? { failureReason } : {}),
      actorId: adminId(req),
    });

    // A manual/offline claim is one with no gateway behind it — Razorpay always
    // stamps `provider`. Recording the human decision separately from the
    // lifecycle event (payment.succeeded/failed, already emitted by
    // transitionPayment) is what makes "who approved this money" auditable
    // rather than inferred.
    if (result.changed && !result.payment.provider) {
      await recordBillingEvent(
        raw === PaymentStatus.SUCCEEDED ? "payment.manual_approved" : "payment.manual_rejected",
        {
          hotelId: result.payment.hotelId,
          actorId: adminId(req),
          actorType: "ADMIN",
          data: {
            paymentId: result.payment.id,
            invoiceId: result.payment.invoiceId,
            amount: result.payment.amount,
            currency: result.payment.currency,
            method: result.payment.method,
            settled: result.settled,
            ...(result.payment.reference ? { reference: result.payment.reference } : {}),
            ...(failureReason ? { rejectionReason: failureReason } : {}),
          },
        },
      );
    }

    res.json(result);
  } catch (err) {
    // Includes the stale-PENDING guards: an invoice settled while this claim
    // waited for review is a 400 the reviewer must see and act on (reject it),
    // not an opaque 500.
    if (
      err instanceof Error &&
      /not found|voided|Cannot transition|already paid|exceeds the outstanding/i.test(err.message)
    ) {
      return res.status(400).json({ error: err.message });
    }
    return serverError(res, err, "Failed to update payment");
  }
}

// GET /admin/payments?hotelId=&status=&page=&limit=
export async function listPaymentsHandler(req: Request, res: Response) {
  try {
    const page = Math.max(1, Number(req.query["page"]) || 1);
    const limit = Math.min(100, Number(req.query["limit"]) || 25);
    const status = String(req.query["status"] ?? "").toUpperCase();
    const hotelId = req.query["hotelId"] ? String(req.query["hotelId"]) : undefined;

    const where: Prisma.PaymentWhereInput = {
      ...(hotelId ? { hotelId } : {}),
      ...(status && status in PaymentStatus ? { status: status as PaymentStatus } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        // SUBMISSION order, not settlement order. `receivedAt` is rewritten to
        // now() when a payment is approved, so it cannot order a queue of
        // unapproved claims; `createdAt` never moves. Backed by the
        // [status, createdAt] index.
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          hotel: { select: { id: true, name: true } },
          invoice: { select: { id: true, number: true, total: true, amountPaid: true, status: true } },
        },
      }),
      prisma.payment.count({ where }),
    ]);

    res.json({ data, total, page, pages: Math.ceil(total / limit), limit });
  } catch (err) {
    return serverError(res, err, "Failed to fetch payments");
  }
}

/**
 * POST /admin/invoices/:id/void
 *
 * WHAT CHANGED — this was a money-destroying action with no trail:
 *
 *  1. **No audit record.** Every sibling money action calls `recordBillingEvent`;
 *     void did not, so the one operation that writes off a receivable was the
 *     one operation with no evidence of who did it or why.
 *  2. **A PARTIALLY PAID invoice could be voided.** Only `PAID` was blocked, so
 *     an invoice with `amountPaid > 0` could be voided while its Payment rows
 *     survived — money that still counted toward revenue analytics against an
 *     invoice that no longer existed. Reversing that requires a refund flow
 *     (P2); until then the honest answer is to refuse.
 *  3. **`reason` overwrote `notes`.** Notes set at issue time were destroyed,
 *     and the input skipped the `parseNonEmptyString` validation every other
 *     handler in this file uses. The reason is now APPENDED.
 *  4. **Already-void invoices** returned 200 and rewrote notes each time.
 */
export async function voidInvoiceHandler(req: Request, res: Response) {
  const invoiceId = req.params["id"]!;

  let reason: string | undefined;
  if (req.body?.reason != null) {
    const parsed = parseNonEmptyString(req.body.reason, "reason", 500);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    reason = parsed.value;
  }

  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status === InvoiceStatus.VOID) {
      return res.status(400).json({ error: "Invoice is already void." });
    }
    if (invoice.status === InvoiceStatus.PAID) {
      return res.status(400).json({ error: "Cannot void a paid invoice. Issue a refund instead." });
    }
    if (invoice.amountPaid > 0) {
      return res.status(400).json({
        error:
          "Cannot void an invoice that has payments recorded against it. " +
          "Refund or reverse the payments first.",
      });
    }

    // Appended, not replaced — notes written at issue time are evidence too.
    const stamped = `[voided ${new Date().toISOString()}] ${reason ?? "no reason given"}`;
    const notes = invoice.notes ? `${invoice.notes}\n${stamped}` : stamped;

    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.VOID, notes },
    });

    await recordBillingEvent("invoice.voided", {
      hotelId: invoice.hotelId,
      actorId: adminId(req),
      actorType: "ADMIN",
      data: {
        invoiceId: invoice.id,
        number: invoice.number,
        total: invoice.total,
        currency: invoice.currency,
        previousStatus: invoice.status,
        reason: reason ?? null,
      },
    });

    res.json(updated);
  } catch (err) {
    return serverError(res, err, "Failed to void invoice");
  }
}

// GET /admin/audit-log?category=&type=&hotelId=&page=&limit=
export async function listAuditLogHandler(req: Request, res: Response) {
  try {
    const result = await listAuditLog({
      category: req.query["category"] ? String(req.query["category"]) : undefined,
      type: req.query["type"] ? String(req.query["type"]) : undefined,
      hotelId: req.query["hotelId"] ? String(req.query["hotelId"]) : undefined,
      page: Number(req.query["page"]) || 1,
      limit: Number(req.query["limit"]) || 50,
    });
    res.json(result);
  } catch (err) {
    return serverError(res, err, "Failed to fetch audit log");
  }
}
