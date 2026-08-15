/**
 * adminBilling.controller.ts
 *
 * Superadmin-facing invoice, payment and audit endpoints. None of this existed:
 * billing was entirely manual with no record of what was owed or collected, and
 * the only "audit trail" was a `console.info` in the browser.
 */
import { Request, Response } from "express";
import { InvoiceStatus, Prisma } from "@prisma/client";
import prisma from "../db/connect";
import { recordPayment } from "../services/invoice.service";
import { listAuditLog } from "../services/audit.service";
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

  try {
    const result = await recordPayment({
      invoiceId,
      ...(amount !== undefined ? { amount } : {}),
      method,
      reference: b.reference ? String(b.reference).slice(0, 120) : undefined,
      notes: b.notes ? String(b.notes).slice(0, 500) : undefined,
      recordedByAdminId: adminId(req),
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof Error && /not found|voided|greater than zero/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    return serverError(res, err, "Failed to record payment");
  }
}

// POST /admin/invoices/:id/void
export async function voidInvoiceHandler(req: Request, res: Response) {
  const invoiceId = req.params["id"]!;
  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status === InvoiceStatus.PAID) {
      return res.status(400).json({ error: "Cannot void a paid invoice. Issue a refund instead." });
    }

    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.VOID, notes: req.body?.reason ? String(req.body.reason).slice(0, 500) : invoice.notes },
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
