"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPlans = listPlans;
exports.createPlanHandler = createPlanHandler;
exports.updatePlanHandler = updatePlanHandler;
exports.assignPlanHandler = assignPlanHandler;
exports.startTrialHandler = startTrialHandler;
const plan_service_1 = require("../services/plan.service");
const billing_service_1 = require("../services/billing.service");
// GET /admin/plans
async function listPlans(req, res) {
    try {
        const plans = await (0, plan_service_1.getPlans)(true); // include inactive for admin view
        res.json(plans);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
// POST /admin/plans
async function createPlanHandler(req, res) {
    try {
        const { name, currency, priceMonthly, conversationLimit, aiReplyLimit, extraConversationCharge, extraAiReplyCharge } = req.body;
        if (!name || priceMonthly == null || conversationLimit == null || aiReplyLimit == null) {
            return res.status(400).json({ error: "name, priceMonthly, conversationLimit, aiReplyLimit are required" });
        }
        const plan = await (0, plan_service_1.createPlan)({
            name: String(name),
            currency: String(currency ?? "USD").toUpperCase(),
            priceMonthly: Number(priceMonthly),
            conversationLimit: Number(conversationLimit),
            aiReplyLimit: Number(aiReplyLimit),
            extraConversationCharge: Number(extraConversationCharge ?? 0),
            extraAiReplyCharge: Number(extraAiReplyCharge ?? 0),
        });
        res.status(201).json(plan);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
// PATCH /admin/plans/:id
async function updatePlanHandler(req, res) {
    try {
        const id = req.params["id"];
        const { name, currency, priceMonthly, conversationLimit, aiReplyLimit, extraConversationCharge, extraAiReplyCharge, isActive } = req.body;
        const plan = await (0, plan_service_1.updatePlan)(id, {
            ...(name !== undefined && { name }),
            ...(currency !== undefined && { currency: String(currency).toUpperCase() }),
            ...(priceMonthly !== undefined && { priceMonthly: Number(priceMonthly) }),
            ...(conversationLimit !== undefined && { conversationLimit: Number(conversationLimit) }),
            ...(aiReplyLimit !== undefined && { aiReplyLimit: Number(aiReplyLimit) }),
            ...(extraConversationCharge !== undefined && { extraConversationCharge: Number(extraConversationCharge) }),
            ...(extraAiReplyCharge !== undefined && { extraAiReplyCharge: Number(extraAiReplyCharge) }),
            ...(isActive !== undefined && { isActive }),
        });
        res.json(plan);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
// PATCH /admin/hotels/:id/plan  — assign plan to hotel
async function assignPlanHandler(req, res) {
    try {
        const hotelId = req.params["id"];
        const { planId } = req.body;
        if (!planId)
            return res.status(400).json({ error: "planId required" });
        const plan = await (0, plan_service_1.getPlanById)(planId);
        if (!plan)
            return res.status(404).json({ error: "Plan not found" });
        const sub = await (0, billing_service_1.assignPlanToHotel)(hotelId, planId);
        res.json(sub);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
// POST /admin/hotels/:id/trial  — start a free trial
async function startTrialHandler(req, res) {
    try {
        const hotelId = req.params["id"];
        const { days, conversationLimit, aiReplyLimit } = req.body;
        const result = await (0, billing_service_1.startTrial)(hotelId, {
            ...(days != null && { durationDays: Math.max(1, Math.min(90, Number(days))) }),
            ...(conversationLimit != null && { conversationLimit: Number(conversationLimit) }),
            ...(aiReplyLimit != null && { aiReplyLimit: Number(aiReplyLimit) }),
        });
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
//# sourceMappingURL=plan.controller.js.map