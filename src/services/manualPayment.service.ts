/**
 * services/manualPayment.service.ts
 *
 * Intake for offline payments — bank transfer, UPI, cash, cheque.
 *
 * THE ONE RULE THIS FILE ENFORCES: a hotel-submitted payment is a **CLAIM**,
 * not money. It is created as `PENDING`, it contributes nothing to
 * `Invoice.amountPaid`, and it becomes money only when a Vaketta admin approves
 * it through the existing `transitionPayment`. A UTR number, a screenshot and a
 * date are evidence for a HUMAN REVIEWER — none of them is machine-verifiable,
 * and nothing here treats them as verification.
 *
 * NOT A SECOND PAYMENT ENGINE. This module writes exactly one PENDING row and
 * stops. Settlement is `transitionPayment → applyPaymentToInvoice →
 * reactivateAfterPayment`, unchanged and untouched. There is no path from this
 * file to `Invoice.amountPaid`.
 *
 * DUNNING IS DELIBERATELY NOT PAUSED. `outstandingBalance` counts
 * `total - amountPaid` on OPEN invoices and never looks at Payment rows, so a
 * PENDING claim leaves the hotel owing exactly what it owed before. That is
 * correct: an unverified claim is not a payment, and pausing suspension on an
 * unverifiable assertion would let anyone extend their own service indefinitely
 * by submitting a claim they never honour.
 */
import { InvoiceStatus, PaymentStatus } from "@prisma/client";
import prisma from "../db/connect";
import { recordPayment } from "./invoice.service";
import { recordBillingEvent } from "./audit.service";
import { uploadToR2, isR2Configured } from "./r2.service";
import { logger } from "../utils/logger";
import type { ManualPaymentMethod } from "../billing/validate";

const log = logger.child({ service: "manual-payment" });

export type SubmitManualPaymentInput = {
  /** From the JWT. Never from the request body. */
  hotelId: string;
  /** From the JWT. Recorded so a claim is attributable to a person. */
  submittedByUserId: string;
  invoiceId: string;
  /** Integer minor units. Validated against the outstanding balance. */
  amount: number;
  method: ManualPaymentMethod;
  claimedPaidAt: Date;
  reference?: string | undefined;
  notes?: string | undefined;
  proof?: { buffer: Buffer; mimeType: string } | undefined;
};

export type SubmitResult =
  | { ok: true; paymentId: string; status: PaymentStatus }
  | {
      ok: false;
      reason:
        | "invoice_not_found"
        | "invoice_void"
        | "invoice_paid"
        | "nothing_outstanding"
        | "amount_exceeds_outstanding"
        | "duplicate_pending";
      message: string;
      /** Populated where it helps the UI show the real figure. */
      outstanding?: number;
    };

/**
 * Record an offline payment claim against one of the hotel's own invoices.
 *
 * Every guard here is a TENANT guard or a MONEY guard; there is no business
 * logic beyond "is this claim plausible enough to put in front of a human".
 */
export async function submitManualPayment(input: SubmitManualPaymentInput): Promise<SubmitResult> {
  // ── Tenant ownership ──────────────────────────────────────────────────────
  // Scoped in the WHERE clause rather than fetched-then-compared, so a foreign
  // invoice is indistinguishable from a non-existent one at every layer.
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, hotelId: input.hotelId },
    select: { id: true, hotelId: true, status: true, currency: true, total: true, amountPaid: true, number: true },
  });

  if (!invoice) {
    return { ok: false, reason: "invoice_not_found", message: "Invoice not found" };
  }

  if (invoice.status === InvoiceStatus.VOID) {
    return { ok: false, reason: "invoice_void", message: "This invoice has been voided." };
  }
  if (invoice.status === InvoiceStatus.PAID) {
    return { ok: false, reason: "invoice_paid", message: "This invoice is already paid." };
  }

  const outstanding = Math.max(0, invoice.total - invoice.amountPaid);
  if (outstanding <= 0) {
    return { ok: false, reason: "nothing_outstanding", message: "This invoice has nothing outstanding." };
  }

  // Partial payment is allowed; over-payment is not. Checked here for a clean
  // 400 with the real figure — `recordPayment` enforces it again as the
  // backstop, because this check is advisory and the balance can move.
  if (input.amount > outstanding) {
    return {
      ok: false,
      reason: "amount_exceeds_outstanding",
      message: `The amount is more than the ${outstanding / 100} ${invoice.currency} outstanding on this invoice.`,
      outstanding,
    };
  }

  // ── Duplicate guard ───────────────────────────────────────────────────────
  // One open claim per invoice. Without this a hotel could queue several claims
  // and, if a reviewer approved more than one, over-credit the invoice —
  // transitionPayment's outstanding check now blocks that too, but refusing at
  // intake keeps the review queue honest and the UI unambiguous.
  const existing = await prisma.payment.findFirst({
    where: { invoiceId: invoice.id, status: PaymentStatus.PENDING },
    select: { id: true },
  });
  if (existing) {
    return {
      ok: false,
      reason: "duplicate_pending",
      message: "A payment for this invoice is already under review.",
    };
  }

  // ── Proof upload (best-effort) ────────────────────────────────────────────
  // A failed upload must NOT lose the claim: the reference number and amount
  // are the substance, the screenshot is a convenience. Losing a submission
  // because R2 blipped would be worse than a claim a reviewer has to chase.
  let proof: { url: string; key: string } | null = null;
  if (input.proof) {
    proof = await uploadProof(input.proof, input.hotelId);
  }

  // ── Create the PENDING claim ──────────────────────────────────────────────
  // Delegates to `recordPayment` — the same writer the admin and gateway paths
  // use — with status PENDING, which short-circuits before
  // `applyPaymentToInvoice`. No invoice field is touched.
  let created;
  try {
    created = await recordPayment({
      invoiceId: invoice.id,
      amount: input.amount,
      method: input.method,
      status: PaymentStatus.PENDING,
      reference: input.reference,
      notes: input.notes,
      // Not admin-recorded: this came from the hotel.
      recordedByAdminId: null,
    });
  } catch (err) {
    // recordPayment's own guards (over-credit, voided invoice) re-raise here if
    // the balance moved between our check and the write.
    if (err instanceof Error && /exceeds the outstanding|voided|greater than zero/i.test(err.message)) {
      return { ok: false, reason: "amount_exceeds_outstanding", message: err.message, outstanding };
    }
    throw err;
  }

  // Claim-specific provenance. Separate from `recordPayment` so that function
  // keeps one shape for all three callers rather than growing manual-only args.
  await prisma.payment.update({
    where: { id: created.payment.id },
    data: {
      submittedByUserId: input.submittedByUserId,
      claimedPaidAt: input.claimedPaidAt,
      ...(proof ? { proofUrl: proof.url, proofKey: proof.key } : {}),
    },
  });

  await recordBillingEvent("payment.manual_submitted", {
    hotelId: invoice.hotelId,
    // A hotel user, not a Vaketta admin — actorType stays SYSTEM because
    // AuditActorType has no TENANT member and inventing one would ripple
    // through every existing audit consumer. The submitter is in `data`.
    actorType: "SYSTEM",
    data: {
      paymentId: created.payment.id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      amount: input.amount,
      currency: invoice.currency,
      method: input.method,
      submittedByUserId: input.submittedByUserId,
      claimedPaidAt: input.claimedPaidAt.toISOString(),
      hasProof: Boolean(proof),
      ...(input.reference ? { reference: input.reference } : {}),
    },
  });

  log.info(
    { paymentId: created.payment.id, invoiceId: invoice.id, hotelId: invoice.hotelId },
    "manual payment claim submitted",
  );

  return { ok: true, paymentId: created.payment.id, status: PaymentStatus.PENDING };
}

/**
 * Mirror a proof file into R2.
 *
 * `uploadToR2` sniffs MAGIC BYTES and re-derives the MIME type, so a `.pdf`
 * that is really an executable is rejected there regardless of what the browser
 * claimed — the controller's own allowlist is defence in depth, not the only
 * check. Returns null on any failure; the caller keeps the claim.
 */
async function uploadProof(
  proof: { buffer: Buffer; mimeType: string },
  hotelId: string,
): Promise<{ url: string; key: string } | null> {
  if (!isR2Configured()) {
    log.warn({ hotelId }, "R2 not configured — payment proof not stored");
    return null;
  }
  try {
    const result = await uploadToR2(proof.buffer, proof.mimeType, { hotelId });
    return { url: result.url, key: result.key };
  } catch (err) {
    log.error({ err, hotelId }, "payment proof upload failed — claim kept without proof");
    return null;
  }
}

/** The hotel's own payment history. Tenant-scoped in the WHERE clause. */
export async function listHotelPayments(hotelId: string, limit = 50) {
  return prisma.payment.findMany({
    where: { hotelId },
    orderBy: { createdAt: "desc" },
    take: Math.min(100, Math.max(1, limit)),
    select: {
      id: true,
      invoiceId: true,
      status: true,
      currency: true,
      amount: true,
      method: true,
      reference: true,
      notes: true,
      claimedPaidAt: true,
      proofUrl: true,
      failureReason: true,
      reviewedAt: true,
      receivedAt: true,
      createdAt: true,
      invoice: { select: { number: true } },
      // reviewedByAdminId / submittedByUserId are deliberately NOT exposed to
      // tenants — internal staff identity is not the hotel's business.
    },
  });
}
