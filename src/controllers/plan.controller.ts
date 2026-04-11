import { Request, Response } from "express";
import {
  createPlan,
  getPlans,
  getPlanById,
  updatePlan,
} from "../services/plan.service";
import { assignPlanToHotel, startTrial } from "../services/billing.service";

// GET /admin/plans
export async function listPlans(req: Request, res: Response) {
  try {
    const plans = await getPlans(true); // include inactive for admin view
    res.json(plans);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// POST /admin/plans
export async function createPlanHandler(req: Request, res: Response) {
  try {
    const { name, currency, priceMonthly, conversationLimit, aiReplyLimit, extraConversationCharge, extraAiReplyCharge } = req.body;
    if (!name || priceMonthly == null || conversationLimit == null || aiReplyLimit == null) {
      return res.status(400).json({ error: "name, priceMonthly, conversationLimit, aiReplyLimit are required" });
    }
    const plan = await createPlan({
      name:                    String(name),
      currency:                String(currency ?? "USD").toUpperCase(),
      priceMonthly:            Number(priceMonthly),
      conversationLimit:       Number(conversationLimit),
      aiReplyLimit:            Number(aiReplyLimit),
      extraConversationCharge: Number(extraConversationCharge ?? 0),
      extraAiReplyCharge:      Number(extraAiReplyCharge ?? 0),
    });
    res.status(201).json(plan);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// PATCH /admin/plans/:id
export async function updatePlanHandler(req: Request, res: Response) {
  try {
    const id = req.params["id"]!;
    const { name, currency, priceMonthly, conversationLimit, aiReplyLimit, extraConversationCharge, extraAiReplyCharge, isActive } = req.body;
    const plan = await updatePlan(id, {
      ...(name                    !== undefined && { name }),
      ...(currency                !== undefined && { currency: String(currency).toUpperCase() }),
      ...(priceMonthly            !== undefined && { priceMonthly: Number(priceMonthly) }),
      ...(conversationLimit       !== undefined && { conversationLimit: Number(conversationLimit) }),
      ...(aiReplyLimit            !== undefined && { aiReplyLimit: Number(aiReplyLimit) }),
      ...(extraConversationCharge !== undefined && { extraConversationCharge: Number(extraConversationCharge) }),
      ...(extraAiReplyCharge      !== undefined && { extraAiReplyCharge: Number(extraAiReplyCharge) }),
      ...(isActive                !== undefined && { isActive }),
    });
    res.json(plan);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// PATCH /admin/hotels/:id/plan  — assign plan to hotel
export async function assignPlanHandler(req: Request, res: Response) {
  try {
    const hotelId = req.params["id"]!;
    const { planId } = req.body;
    if (!planId) return res.status(400).json({ error: "planId required" });

    const plan = await getPlanById(planId);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const sub = await assignPlanToHotel(hotelId, planId);
    res.json(sub);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// POST /admin/hotels/:id/trial  — start a free trial
export async function startTrialHandler(req: Request, res: Response) {
  try {
    const hotelId = req.params["id"]!;
    const { days, conversationLimit, aiReplyLimit } = req.body;

    const result = await startTrial(hotelId, {
      ...(days              != null && { durationDays:      Math.max(1, Math.min(90, Number(days))) }),
      ...(conversationLimit != null && { conversationLimit: Number(conversationLimit) }),
      ...(aiReplyLimit      != null && { aiReplyLimit:      Number(aiReplyLimit) }),
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
