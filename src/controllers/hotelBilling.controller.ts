import { Request, Response } from "express";
import { getHotelBilling } from "../services/billing.service";
import { getCurrentUsage, getUsageHistory } from "../services/usage.service";
import { getPlans } from "../services/plan.service";

type JwtUser = { id: string; role: string; hotelId: string };

function hotelId(req: Request): string {
  return (req as any).user.hotelId;
}

// GET /hotel-settings/billing/subscription
export async function getSubscription(req: Request, res: Response) {
  try {
    const { hotel, subscription } = await getHotelBilling(hotelId(req));
    res.json({
      status:           hotel.subscriptionStatus,
      billingStartDate: hotel.billingStartDate,
      billingEndDate:   hotel.billingEndDate,
      plan: hotel.plan
        ? {
            id:                      hotel.plan.id,
            name:                    hotel.plan.name,
            priceMonthly:            hotel.plan.priceMonthly,
            conversationLimit:       hotel.plan.conversationLimit,
            aiReplyLimit:            hotel.plan.aiReplyLimit,
            extraConversationCharge: hotel.plan.extraConversationCharge,
            extraAiReplyCharge:      hotel.plan.extraAiReplyCharge,
          }
        : null,
      // snapshot (what the hotel is actually billed for this cycle)
      snapshot: subscription
        ? {
            planName:               subscription.planName,
            price:                  subscription.price,
            conversationLimit:      subscription.conversationLimit,
            aiReplyLimit:           subscription.aiReplyLimit,
            extraConversationCharge: subscription.extraConversationCharge,
            extraAiReplyCharge:     subscription.extraAiReplyCharge,
            startDate:              subscription.startDate,
            endDate:                subscription.endDate,
          }
        : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /hotel-settings/billing/usage
export async function getUsage(req: Request, res: Response) {
  try {
    const hid = hotelId(req);
    const [current, history] = await Promise.all([
      getCurrentUsage(hid),
      getUsageHistory(hid, 6),
    ]);
    res.json({ current, history });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /hotel-settings/billing/plans  — public plan list for upgrade UI
export async function getAvailablePlans(req: Request, res: Response) {
  try {
    const plans = await getPlans(false); // active only
    res.json(plans);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
