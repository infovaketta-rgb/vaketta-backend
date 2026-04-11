"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSubscription = getSubscription;
exports.getUsage = getUsage;
exports.getAvailablePlans = getAvailablePlans;
const billing_service_1 = require("../services/billing.service");
const usage_service_1 = require("../services/usage.service");
const plan_service_1 = require("../services/plan.service");
function hotelId(req) {
    return req.user.hotelId;
}
// GET /hotel-settings/billing/subscription
async function getSubscription(req, res) {
    try {
        const { hotel, subscription } = await (0, billing_service_1.getHotelBilling)(hotelId(req));
        res.json({
            status: hotel.subscriptionStatus,
            billingStartDate: hotel.billingStartDate,
            billingEndDate: hotel.billingEndDate,
            plan: hotel.plan
                ? {
                    id: hotel.plan.id,
                    name: hotel.plan.name,
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
                    price: subscription.price,
                    conversationLimit: subscription.conversationLimit,
                    aiReplyLimit: subscription.aiReplyLimit,
                    extraConversationCharge: subscription.extraConversationCharge,
                    extraAiReplyCharge: subscription.extraAiReplyCharge,
                    startDate: subscription.startDate,
                    endDate: subscription.endDate,
                }
                : null,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
// GET /hotel-settings/billing/usage
async function getUsage(req, res) {
    try {
        const hid = hotelId(req);
        const [current, history] = await Promise.all([
            (0, usage_service_1.getCurrentUsage)(hid),
            (0, usage_service_1.getUsageHistory)(hid, 6),
        ]);
        res.json({ current, history });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
// GET /hotel-settings/billing/plans  — public plan list for upgrade UI
async function getAvailablePlans(req, res) {
    try {
        const plans = await (0, plan_service_1.getPlans)(false); // active only
        res.json(plans);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
//# sourceMappingURL=hotelBilling.controller.js.map