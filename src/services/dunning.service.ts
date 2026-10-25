/**
 * dunning.service.ts
 *
 * Tells customers what is about to happen to their account, and moves lapsed
 * accounts through PAST_DUE → EXPIRED.
 *
 * WHY THIS EXISTS
 * ---------------
 * Expiry used to be a silent, single `updateMany` that flipped a status. No
 * warning before, no notice after, no grace period, no socket event, no audit
 * record. A hotel's bot simply stopped answering guests one morning, and the
 * first anyone knew of it was a support ticket.
 *
 * IDEMPOTENCY: every notice is guarded by an AuditLog lookup scoped to the
 * current period (`hasEvent`). A container restart, a second instance, or a
 * re-run of the cron tick cannot re-send. `hasEvent` fails CLOSED — if we can't
 * prove a notice wasn't already sent, we don't send it, because spamming a
 * paying customer is worse than missing one reminder.
 */
import { SubscriptionStatus } from "@prisma/client";
import prisma from "../db/connect";
import { logger } from "../utils/logger";
import { sendEmail } from "../utils/mailer";
import { daysUntil } from "../billing/period";
import { hasEvent, recordBillingEvent, type BillingEventType } from "./audit.service";
import { findOverdueInvoices, findJustOverdueInvoices } from "./invoice.service";
import { getBillingConfig, markPastDue, LIVE_STATUSES } from "./billing.service";

const log = logger.child({ service: "dunning" });

const APP_NAME = "Vaketta Chat";
const SUPPORT_EMAIL = process.env["SUPPORT_EMAIL"] ?? "support@vaketta.com";

/** Days before period end at which we warn. Descending so the nearest wins. */
const REMINDER_DAYS = [7, 3, 1];

// ── Email rendering ──────────────────────────────────────────────────────────

function shell(title: string, bodyHtml: string): string {
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0C1B33">
      <h2 style="margin:0 0 12px;font-size:20px;color:#0C1B33">${title}</h2>
      ${bodyHtml}
      <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#94A3B8">
        Questions? Reply to this email or contact ${SUPPORT_EMAIL}.
      </p>
    </div>`;
}

function para(text: string): string {
  return `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#475569">${text}</p>`;
}

/**
 * Recipients for a hotel's billing mail: its active ADMIN/OWNER users.
 * Falls back to the hotel's own contact address when no such user exists.
 */
async function billingRecipients(hotelId: string): Promise<string[]> {
  const [users, hotel] = await Promise.all([
    prisma.user.findMany({
      where: { hotelId, isActive: true, role: { in: ["ADMIN", "OWNER"] } },
      select: { email: true },
    }),
    prisma.hotel.findUnique({ where: { id: hotelId }, select: { email: true } }),
  ]);

  const emails = users.map((u) => u.email).filter(Boolean);
  if (emails.length > 0) return [...new Set(emails)];
  return hotel?.email ? [hotel.email] : [];
}

/**
 * Send one notice to a hotel's billing contacts, exactly once per period.
 * Never throws — a mail failure must not stop the cron from processing the
 * rest of the batch.
 */
async function notifyOnce(
  type: BillingEventType,
  hotelId: string,
  since: Date,
  subject: string,
  html: string,
  text: string,
): Promise<boolean> {
  if (await hasEvent(type, hotelId, since)) return false;

  const recipients = await billingRecipients(hotelId);
  if (recipients.length === 0) {
    log.warn({ hotelId, type }, "no billing contact for hotel — notice not sent");
    // Recorded anyway: without it we would retry this lookup every tick forever.
    await recordBillingEvent(type, { hotelId, actorType: "SYSTEM", data: { delivered: false, reason: "no_recipient" } });
    return false;
  }

  let delivered = 0;
  for (const to of recipients) {
    try {
      await sendEmail(to, subject, html, text);
      delivered++;
    } catch (err) {
      log.error({ err, hotelId, type }, "billing notice email failed");
    }
  }

  // Record even on total failure — otherwise a permanently broken mail
  // transport turns into an unbounded retry loop against the mail provider.
  await recordBillingEvent(type, {
    hotelId,
    actorType: "SYSTEM",
    data: { delivered: delivered > 0, recipients: recipients.length },
  });

  try {
    const { emitToHotel } = await import("../realtime/emit");
    emitToHotel(hotelId, "staff:notification", { kind: "billing", type, message: subject });
  } catch {
    /* socket is best-effort */
  }

  return delivered > 0;
}

// ── Pass 1: upcoming renewal / trial ending ──────────────────────────────────

export async function sendRenewalReminders(now: Date = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + REMINDER_DAYS[0]! * 86_400_000);

  const upcoming = await prisma.subscription.findMany({
    where: {
      status: { in: [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE] },
      endDate: { gt: now, lte: horizon },
    },
    select: {
      hotelId: true,
      status: true,
      endDate: true,
      planName: true,
      startDate: true,
      autoRenew: true,
      scheduledPlanId: true,
    },
  });

  let sent = 0;

  for (const sub of upcoming) {
    const days = daysUntil(now, sub.endDate!);
    if (!REMINDER_DAYS.includes(days)) continue;

    const isTrial = sub.status === SubscriptionStatus.TRIALING;
    // A trial with a plan already queued for its boundary is not at risk, so it
    // gets a handover notice rather than "choose a plan before your bot stops"
    // — telling a customer to do something they have already done reads as a
    // system that does not know its own state.
    const isScheduledTrial = isTrial && !!sub.scheduledPlanId;
    const when = days === 1 ? "tomorrow" : `in ${days} days`;

    const subject = isScheduledTrial
      ? `Your ${APP_NAME} plan starts ${when}`
      : isTrial
        ? `Your ${APP_NAME} trial ends ${when}`
        : `Your ${APP_NAME} subscription renews ${when}`;

    const html = shell(
      subject,
      isScheduledTrial
        ? para(`Your free trial ends <strong>${when}</strong>, and your paid plan starts at that exact moment — there is no gap and nothing to do.`) +
            para(`We'll email your first invoice once the new billing period begins.`)
        : isTrial
          ? para(`Your free trial ends <strong>${when}</strong>. To keep your WhatsApp and Instagram automation running, choose a plan before then.`) +
              para(`If your trial ends without a plan, your bot stops replying to guests. Your conversations and bookings stay available to your team.`)
          : para(`Your <strong>${sub.planName}</strong> plan renews <strong>${when}</strong>. No action is needed — we'll email your invoice once the new period starts.`),
    );

    const text = isScheduledTrial
      ? `Your ${APP_NAME} trial ends ${when} and your paid plan starts immediately after. No action needed.`
      : isTrial
        ? `Your ${APP_NAME} trial ends ${when}. Choose a plan to keep your automation running.`
        : `Your ${APP_NAME} ${sub.planName} plan renews ${when}. No action needed.`;

    // Scoped to this period, so the same hotel can be reminded again next cycle.
    if (await notifyOnce("notice.renewal_upcoming", sub.hotelId, sub.startDate, subject, html, text)) {
      sent++;
    }
  }

  return sent;
}

// ── Pass 2: overdue invoices → PAST_DUE, then EXPIRED ────────────────────────

/**
 * Move hotels with an overdue invoice into PAST_DUE (service continues), then
 * suspend the ones still unpaid after the grace window.
 */
export async function advanceDelinquent(now: Date = new Date()): Promise<{ pastDue: number; suspended: number }> {
  const { gracePeriodDays } = await getBillingConfig();

  let pastDue = 0;
  let suspended = 0;

  // 2a. Just overdue — warn and flag, but keep serving.
  for (const inv of await findJustOverdueInvoices(now)) {
    try {
      const changed = await markPastDue(inv.hotelId);
      if (changed) pastDue++;

      const subject = `Invoice ${inv.number} is overdue`;
      const html = shell(
        subject,
        para(`Invoice <strong>${inv.number}</strong> was due on ${inv.dueAt.toDateString()} and is still unpaid.`) +
          para(`Your service is running normally for now. If it stays unpaid for ${gracePeriodDays} more days, automated replies will be paused.`) +
          para(`If you've already paid, ignore this — payments can take a day to be recorded.`),
      );
      const text = `Invoice ${inv.number} is overdue. Service continues for ${gracePeriodDays} more days.`;

      await notifyOnce("notice.past_due", inv.hotelId, inv.dueAt, subject, html, text);
    } catch (err) {
      log.error({ err, hotelId: inv.hotelId, invoiceId: inv.id }, "past-due handling failed");
    }
  }

  // 2b. Past the grace window — suspend.
  for (const inv of await findOverdueInvoices(now, gracePeriodDays)) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const res = await tx.hotel.updateMany({
          where: { id: inv.hotelId, subscriptionStatus: { in: LIVE_STATUSES } },
          data: { subscriptionStatus: SubscriptionStatus.EXPIRED },
        });
        if (res.count === 0) return false;
        await tx.subscription.updateMany({
          where: { hotelId: inv.hotelId, status: { in: LIVE_STATUSES } },
          data: { status: SubscriptionStatus.EXPIRED },
        });
        return true;
      });

      if (result) {
        const { invalidateSubscriptionStatusCache } = await import("./billing.service");
        invalidateSubscriptionStatusCache(inv.hotelId);
        suspended++;

        await recordBillingEvent("subscription.expired", {
          hotelId: inv.hotelId,
          actorType: "SYSTEM",
          data: { reason: "unpaid_invoice", invoiceId: inv.id, number: inv.number },
        });

        const { emitToAdmin } = await import("../realtime/emit");
        emitToAdmin("admin:subscription_changed", {
          hotelId: inv.hotelId,
          planId: null,
          status: SubscriptionStatus.EXPIRED,
          billingEndDate: null,
        });
      }

      const subject = `${APP_NAME} automation paused — invoice ${inv.number} unpaid`;
      const html = shell(
        subject,
        para(`Invoice <strong>${inv.number}</strong> has been unpaid past its grace period, so automated replies are now paused.`) +
          para(`<strong>Your data is safe.</strong> You and your team can still sign in and read every conversation and booking — only automated replies and sending are paused.`) +
          para(`Settle the invoice to resume immediately.`),
      );
      const text = `${APP_NAME} automation paused — invoice ${inv.number} unpaid. Your conversations and bookings remain readable.`;

      await notifyOnce("notice.expired", inv.hotelId, inv.dueAt, subject, html, text);
    } catch (err) {
      log.error({ err, hotelId: inv.hotelId, invoiceId: inv.id }, "suspension handling failed");
    }
  }

  return { pastDue, suspended };
}

// ── Pass 3: notify hotels suspended by date (trial lapse, cancellation) ──────

/**
 * Tell hotels that were suspended by `expireOverdueSubscriptions` (period simply
 * ran out — an ended trial, or a cancelled plan reaching its date) rather than
 * by an unpaid invoice.
 */
export async function notifyRecentlySuspended(now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 2 * 86_400_000);

  const hotels = await prisma.hotel.findMany({
    where: {
      subscriptionStatus: SubscriptionStatus.EXPIRED,
      billingEndDate: { gte: since, lte: now },
    },
    select: { id: true, billingEndDate: true },
  });

  let sent = 0;

  for (const hotel of hotels) {
    const subject = `${APP_NAME} automation paused`;
    const html = shell(
      subject,
      para(`Your subscription period ended, so automated replies to guests are now paused.`) +
        para(`<strong>Your data is safe.</strong> You and your team can still sign in and read every conversation and booking — only automated replies and sending are paused.`) +
        para(`Choose a plan from your Subscription page to resume.`),
    );
    const text = `${APP_NAME} automation paused — your subscription period ended. Conversations and bookings remain readable.`;

    if (await notifyOnce("notice.expired", hotel.id, hotel.billingEndDate ?? since, subject, html, text)) {
      sent++;
    }
  }

  return sent;
}
