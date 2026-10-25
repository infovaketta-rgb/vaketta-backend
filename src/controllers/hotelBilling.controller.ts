/**
 * hotelBilling.controller.ts — the hotel-facing billing API.
 *
 * WHAT CHANGED
 * ------------
 * 1. **`currency` was never returned.** The response hand-picked fields and
 *    omitted it from BOTH `plan` and `snapshot`, so the frontend's
 *    `getCurrencySymbol(undefined)` fell back to the hotel's *booking* currency
 *    (default ₹) and a USD plan rendered as "₹49.00" — while the plan cards
 *    lower on the same page, fed by a different endpoint, showed the real one.
 *
 * 2. **Overage was computed in the browser.** The Subscription page multiplied
 *    units by rates client-side and called it an "estimate". The server now
 *    returns the same figure the invoice will charge, from billing/overage.ts.
 *
 * 3. **`TrialConfig.trialMessage` is finally used.** It is admin-editable and
 *    labelled "Shown to hotel staff on their Subscription page during trial" —
 *    and no endpoint had ever returned it.
 *
 * 4. **Invoices are exposed**, so a hotel can see what it actually owes.
 *
 * 5. `/billing/plans` no longer leaks `_count.hotels` to tenants, and filters to
 *    plans available in the hotel's country.
 *
 * 6. **Status and period come from the RESOLVER, not the stored columns.**
 *    `Hotel.subscriptionStatus` / `billingEndDate` are maintained by a cron that
 *    runs every 30 minutes, so between a trial boundary and the next tick this
 *    endpoint reported a state the customer was no longer in. It now reports
 *    what `billing/effectiveStatus.ts` says is true at this instant — the same
 *    answer the middleware enforces.
 *
 * 7. **Periods are exposed as half-open `[start, end)`.** `periodEnd` is the
 *    exclusive boundary; `periodEndInclusive` is the last instant that belongs
 *    to the period, which is what a UI should format ("15 Aug → 14 Sep").
 */
import { Request, Response } from "express";
import { getHotelBilling, getEffectiveSubscription } from "../services/billing.service";
import { getCurrentUsage, getUsageHistory, resolveUsagePeriod } from "../services/usage.service";
import { getPlans, getPlanById } from "../services/plan.service";
import { listHotelInvoices } from "../services/invoice.service";
import { computeOverage } from "../billing/overage";
import { inclusiveEnd } from "../billing/period";
import { getTrialConfig } from "../services/trialConfig.service";
import { serverError } from "../utils/serverError";
import prisma from "../db/connect";

function hotelId(req: Request): string {
  return (req as any).user.hotelId;
}

// GET /hotel-settings/billing/subscription
export async function getSubscription(req: Request, res: Response) {
  try {
    const hid = hotelId(req);
    const [{ hotel, subscription }, effective] = await Promise.all([
      getHotelBilling(hid),
      getEffectiveSubscription(hid),
    ]);

    const status = effective?.status ?? hotel.subscriptionStatus;

    // Only fetched while trialing — no reason to hit the table otherwise.
    let trialMessage: string | null = null;
    if (status === "TRIALING") {
      try {
        trialMessage = (await getTrialConfig()).trialMessage || null;
      } catch {
        trialMessage = null; // cosmetic — never fail the page over it
      }
    }

    // The plan queued to take over the instant the trial ends. Surfaced so the
    // customer can see the handover is arranged rather than fearing a cut-off.
    let scheduledPlan: { id: string; name: string; currency: string; priceMonthly: number } | null = null;
    if (subscription?.scheduledPlanId) {
      try {
        const plan = await getPlanById(subscription.scheduledPlanId);
        if (plan) {
          scheduledPlan = {
            id: plan.id,
            name: plan.name,
            currency: plan.currency,
            priceMonthly: plan.priceMonthly,
          };
        }
      } catch {
        scheduledPlan = null; // cosmetic
      }
    }

    const periodStart = effective?.periodStart ?? hotel.billingStartDate;
    const periodEnd = effective?.periodEnd ?? hotel.billingEndDate;

    res.json({
      status,
      // Kept for back-compat with anything reading the old field names; both
      // now carry the EFFECTIVE period rather than the last-materialised one.
      billingStartDate: periodStart,
      billingEndDate: periodEnd,
      periodStart,
      /** Exclusive boundary. */
      periodEnd,
      /** Last instant of the period — format this for an inclusive end date. */
      periodEndInclusive: periodEnd ? inclusiveEnd(periodEnd) : null,
      billingAnchorDay: effective?.anchorDay ?? null,
      /** True while the trial has converted but the cron has not yet caught up. */
      trialConverted: effective?.trialConverted ?? false,
      trialEndsAt: subscription?.status === "TRIALING" ? subscription.endDate : null,
      scheduledPlan,
      trialMessage,
      plan: hotel.plan
        ? {
            id: hotel.plan.id,
            name: hotel.plan.name,
            currency: hotel.plan.currency,
            priceMonthly: hotel.plan.priceMonthly,
            conversationLimit: hotel.plan.conversationLimit,
            aiReplyLimit: hotel.plan.aiReplyLimit,
            extraConversationCharge: hotel.plan.extraConversationCharge,
            extraAiReplyCharge: hotel.plan.extraAiReplyCharge,
          }
        : null,
      // snapshot (what the hotel is actually billed for this cycle)
      snapshot: subscription
        ? {
            planName: subscription.planName,
            currency: subscription.currency,
            price: subscription.price,
            conversationLimit: subscription.conversationLimit,
            aiReplyLimit: subscription.aiReplyLimit,
            extraConversationCharge: subscription.extraConversationCharge,
            extraAiReplyCharge: subscription.extraAiReplyCharge,
            // The effective period, so a lapsed-but-renewing subscription shows
            // the cycle the customer is actually in.
            startDate: periodStart ?? subscription.startDate,
            endDate: periodEnd ?? subscription.endDate,
            autoRenew: subscription.autoRenew,
          }
        : null,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Hotel not found") {
      return res.status(404).json({ error: "Hotel not found" });
    }
    return serverError(res, err, "Failed to load subscription");
  }
}

// GET /hotel-settings/billing/usage
export async function getUsage(req: Request, res: Response) {
  try {
    const hid = hotelId(req);
    const [current, history, effective, period] = await Promise.all([
      getCurrentUsage(hid),
      getUsageHistory(hid, 6),
      getEffectiveSubscription(hid),
      resolveUsagePeriod(hid),
    ]);

    // Computed server-side from the terms IN FORCE, using the same function the
    // invoice generator uses — so what a hotel sees mid-cycle is what it is
    // billed. Previously the browser did this arithmetic; and reading the raw
    // subscription row here would show trial limits against the paid period's
    // usage in the window before a conversion is materialised.
    const terms = effective?.terms ?? null;
    const overage = terms
      ? computeOverage(current, terms)
      : { conversationOverage: 0, aiReplyOverage: 0, conversationCharge: 0, aiReplyCharge: 0, total: 0 };

    res.json({
      current,
      history,
      overage,
      // The usage window, which now tracks the BILLING period rather than the
      // calendar month — so "resets at the start of each billing cycle" is true.
      period: {
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        periodEndInclusive: inclusiveEnd(period.periodEnd),
        month: period.month,
      },
      currency: terms?.currency ?? null,
      limits: terms ? { conversations: terms.conversationLimit, aiReplies: terms.aiReplyLimit } : null,
    });
  } catch (err) {
    return serverError(res, err, "Failed to load usage");
  }
}

// GET /hotel-settings/billing/plans — plans this hotel can upgrade to
export async function getAvailablePlans(req: Request, res: Response) {
  try {
    const config = await prisma.hotelConfig.findUnique({
      where: { hotelId: hotelId(req) },
      select: { country: true },
    });

    const plans = await getPlans({ country: config?.country ?? null });

    // Strip admin-only fields — `_count.hotels` was being handed to tenants.
    res.json(
      plans.map((p) => ({
        id: p.id,
        name: p.name,
        currency: p.currency,
        country: p.country,
        priceMonthly: p.priceMonthly,
        conversationLimit: p.conversationLimit,
        aiReplyLimit: p.aiReplyLimit,
        extraConversationCharge: p.extraConversationCharge,
        extraAiReplyCharge: p.extraAiReplyCharge,
      })),
    );
  } catch (err) {
    return serverError(res, err, "Failed to fetch plans");
  }
}

// GET /hotel-settings/billing/invoices
export async function getInvoices(req: Request, res: Response) {
  try {
    const invoices = await listHotelInvoices(hotelId(req), 24);
    res.json(
      invoices.map((inv) => ({
        id: inv.id,
        number: inv.number,
        status: inv.status,
        currency: inv.currency,
        subtotal: inv.subtotal,
        overageTotal: inv.overageTotal,
        // Exposed so the invoice a hotel sees adds up. Without these the tax
        // columns would be write-only: `total` would exceed
        // `subtotal + overageTotal` with nothing on screen explaining the gap.
        // 0 on every existing invoice, so nothing rendered changes today.
        taxTotal: inv.taxTotal,
        taxLabel: inv.taxLabel,
        total: inv.total,
        amountPaid: inv.amountPaid,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        issuedAt: inv.issuedAt,
        dueAt: inv.dueAt,
        paidAt: inv.paidAt,
        lineItems: inv.lineItems,
      })),
    );
  } catch (err) {
    return serverError(res, err, "Failed to fetch invoices");
  }
}
