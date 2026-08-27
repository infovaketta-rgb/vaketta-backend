/**
 * controllers/manualPayment.controller.ts
 *
 * Hotel-facing offline payment submission.
 *
 * MOUNT LOCATION IS LOAD-BEARING — these live under `/hotel-settings/billing/*`
 * because `requireActiveSubscription` exempts that prefix from the 402 paywall
 * for ALL methods. A SUSPENDED hotel is precisely the customer who needs to
 * report a bank transfer, and any other mount point would 402 them out of it.
 *
 * WHAT THE BROWSER MAY DECIDE: which of its OWN invoices to pay, how much (up
 * to the outstanding balance), and what evidence to attach. What it may NOT
 * decide: the hotel, the payment status, or whether anything is verified. The
 * hotel comes from the JWT; the status is always PENDING; verification is a
 * human being in the Vaketta admin panel.
 */
import { Request, Response } from "express";
import {
  submitManualPayment,
  listHotelPayments,
} from "../services/manualPayment.service";
import {
  parseMinorAmount,
  parseNonEmptyString,
  parsePaymentMethod,
  parseClaimedDate,
} from "../billing/validate";
import { serverError } from "../utils/serverError";
import { logger } from "../utils/logger";

const log = logger.child({ service: "manual-payment-controller" });

/** Proof files only — a payment slip is an image or a PDF, nothing else. */
const ALLOWED_PROOF_MIME = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

function hotelId(req: Request): string {
  return (req as any).user.hotelId;
}
function userId(req: Request): string {
  return (req as any).user.id;
}

/**
 * POST /hotel-settings/billing/invoices/:invoiceId/manual-payment
 *
 * Accepts `multipart/form-data` (with an optional `proof` file) or plain JSON.
 * Creates a PENDING claim. Settles nothing.
 */
export async function submitManualPaymentHandler(req: Request, res: Response) {
  const invoiceId = req.params["invoiceId"]!;
  const b = req.body ?? {};

  // ── Validation ────────────────────────────────────────────────────────────
  // Multipart sends every field as a string, so the numeric amount is parsed
  // from text in both content types — `parseMinorAmount` handles that.
  const amountParsed = parseMinorAmount(b.amount, "amount");
  if (!amountParsed.ok) return res.status(400).json({ error: amountParsed.error });
  if (amountParsed.value <= 0) {
    return res.status(400).json({ error: "amount must be greater than zero." });
  }

  const methodParsed = parsePaymentMethod(b.method);
  if (!methodParsed.ok) return res.status(400).json({ error: methodParsed.error });

  const dateParsed = parseClaimedDate(b.claimedPaidAt, "claimedPaidAt");
  if (!dateParsed.ok) return res.status(400).json({ error: dateParsed.error });

  // Reference is required for every method except CASH, where there is nothing
  // to reference — a UTR/cheque number is the only thread a reviewer can pull.
  let reference: string | undefined;
  if (b.reference != null && String(b.reference).trim() !== "") {
    const parsed = parseNonEmptyString(b.reference, "reference", 120);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    reference = parsed.value;
  } else if (methodParsed.value !== "CASH") {
    return res.status(400).json({
      error: "A transaction reference (UTR / cheque number) is required for this payment method.",
    });
  }

  let notes: string | undefined;
  if (b.notes != null && String(b.notes).trim() !== "") {
    const parsed = parseNonEmptyString(b.notes, "notes", 500);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    notes = parsed.value;
  }

  // ── Proof (optional) ──────────────────────────────────────────────────────
  // A declared MIME allowlist here; `uploadToR2` independently sniffs magic
  // bytes and will reject a mislabelled file regardless of what we accept.
  const file = (req as any).file as { buffer: Buffer; mimetype: string } | undefined;
  let proof: { buffer: Buffer; mimeType: string } | undefined;
  if (file) {
    if (!ALLOWED_PROOF_MIME.has(file.mimetype)) {
      return res.status(400).json({
        error: "Proof must be a JPEG, PNG, WebP image or a PDF.",
      });
    }
    proof = { buffer: file.buffer, mimeType: file.mimetype };
  }

  try {
    const result = await submitManualPayment({
      hotelId: hotelId(req),
      submittedByUserId: userId(req),
      invoiceId,
      amount: amountParsed.value,
      method: methodParsed.value,
      claimedPaidAt: dateParsed.value,
      reference,
      notes,
      proof,
    });

    if (!result.ok) {
      // A foreign or missing invoice is a 404 — a 403 would confirm the id
      // exists and let one hotel enumerate another's invoices.
      const status = result.reason === "invoice_not_found" ? 404 : 400;
      return res.status(status).json({
        error: result.message,
        code: result.reason,
        ...(result.outstanding !== undefined ? { outstanding: result.outstanding } : {}),
      });
    }

    return res.status(201).json({
      paymentId: result.paymentId,
      status: result.status,
      message: "Payment submitted for review. We'll confirm once it's verified.",
    });
  } catch (err) {
    return serverError(res, err, "Failed to submit payment");
  }
}

/** GET /hotel-settings/billing/payments — the hotel's own payment history. */
export async function listMyPaymentsHandler(req: Request, res: Response) {
  try {
    const payments = await listHotelPayments(hotelId(req));
    return res.json(payments);
  } catch (err) {
    return serverError(res, err, "Failed to fetch payments");
  }
}

/** Surfaced to the UI so the method dropdown and the server cannot disagree. */
export function manualPaymentMethodsHandler(_req: Request, res: Response) {
  log.debug("manual payment methods requested");
  return res.json({ methods: ["BANK_TRANSFER", "UPI", "CASH", "CHEQUE", "OTHER"] });
}
