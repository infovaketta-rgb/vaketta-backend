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
 */
import { Request, Response } from "express";
import { getHotelBilling } from "../services/billing.service";
import { getCurrentUsage, getUsageHistory } from "../services/usage.service";
import { getPlans } from "../services/plan.service";
import { listHotelInvoices } from "../services/invoice.service";
import { computeOverage } from "../billing/overage";
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
    const { hotel, subscription } = await getHotelBilling(hid);

    // Only fetched while trialing — no reason to hit the table otherwise.
    let trialMessage: string | null = null;
    if (hotel.subscriptionStatus === "TRIALING") {
      try {
        trialMessage = (await getTrialConfig()).trialMessage || null;
      } catch {
        trialMessage = null; // cosmetic — never fail the page over it
      }
    }

    res.json({
      status: hotel.subscriptionStatus,
      billingStartDate: hotel.billingStartDate,
      billingEndDate: hotel.billingEndDate,
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
            startDate: subscription.startDate,
            endDate: subscription.endDate,
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
    const [current, history, { subscription }] = await Promise.all([
      getCurrentUsage(hid),
      getUsageHistory(hid, 6),
      getHotelBilling(hid),
    ]);

    // Computed server-side from the SNAPSHOT terms, using the same function the
    // invoice generator uses — so what a hotel sees mid-cycle is what it is
    // billed. Previously the browser did this arithmetic.
    const overage = subscription
      ? computeOverage(current, subscription)
      : { conversationOverage: 0, aiReplyOverage: 0, conversationCharge: 0, aiReplyCharge: 0, total: 0 };

    res.json({
      current,
      history,
      overage,
      currency: subscription?.currency ?? null,
      limits: subscription
        ? { conversations: subscription.conversationLimit, aiReplies: subscription.aiReplyLimit }
        : null,
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
