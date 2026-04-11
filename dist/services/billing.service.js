"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignPlanToHotel = assignPlanToHotel;
exports.startTrial = startTrial;
exports.getHotelBilling = getHotelBilling;
exports.getAdminBillingAnalytics = getAdminBillingAnalytics;
exports.expireOverdueSubscriptions = expireOverdueSubscriptions;
const connect_1 = __importDefault(require("../db/connect"));
// ── Date helpers (no external deps) ──────────────────────────────────────────
function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
}
function startOfNextMonth(d) {
    return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}
// ── Plan assignment (creates subscription snapshot) ────────────────────────────
async function assignPlanToHotel(hotelId, planId) {
    const plan = await connect_1.default.plan.findUniqueOrThrow({ where: { id: planId } });
    const now = new Date();
    const startDate = startOfMonth(now);
    const endDate = startOfNextMonth(now);
    // Snapshot subscription — preserves terms even if plan is later edited
    const subscription = await connect_1.default.subscription.create({
        data: {
            hotelId,
            planId,
            planName: plan.name,
            currency: plan.currency,
            price: plan.priceMonthly,
            conversationLimit: plan.conversationLimit,
            aiReplyLimit: plan.aiReplyLimit,
            extraConversationCharge: plan.extraConversationCharge,
            extraAiReplyCharge: plan.extraAiReplyCharge,
            startDate,
            endDate,
        },
    });
    await connect_1.default.hotel.update({
        where: { id: hotelId },
        data: {
            planId,
            subscriptionStatus: "active",
            billingStartDate: startDate,
            billingEndDate: endDate,
        },
    });
    return subscription;
}
// ── Trial assignment ──────────────────────────────────────────────────────────
async function startTrial(hotelId, overrides) {
    // Load global defaults, then apply per-call overrides
    const config = await connect_1.default.trialConfig.upsert({
        where: { id: "global" },
        update: {},
        create: { id: "global" },
    });
    const days = overrides?.durationDays ?? config.durationDays;
    const convLim = overrides?.conversationLimit ?? config.conversationLimit;
    const aiLim = overrides?.aiReplyLimit ?? config.aiReplyLimit;
    const now = new Date();
    const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    // Create a snapshot-style subscription so trial limits are visible in the billing controller
    await connect_1.default.subscription.create({
        data: {
            hotelId,
            planId: null,
            planName: "Trial",
            currency: "USD",
            price: 0,
            conversationLimit: convLim,
            aiReplyLimit: aiLim,
            extraConversationCharge: 0,
            extraAiReplyCharge: 0,
            startDate: now,
            endDate,
        },
    });
    await connect_1.default.hotel.update({
        where: { id: hotelId },
        data: {
            planId: null,
            subscriptionStatus: "trial",
            billingStartDate: now,
            billingEndDate: endDate,
        },
    });
    return {
        subscriptionStatus: "trial",
        billingStartDate: now,
        billingEndDate: endDate,
        conversationLimit: convLim,
        aiReplyLimit: aiLim,
        durationDays: days,
    };
}
// ── Read hotel billing state ───────────────────────────────────────────────────
async function getHotelBilling(hotelId) {
    const hotel = await connect_1.default.hotel.findUnique({
        where: { id: hotelId },
        include: { plan: true },
    });
    if (!hotel)
        throw new Error("Hotel not found");
    // Latest subscription snapshot
    const subscription = await connect_1.default.subscription.findFirst({
        where: { hotelId },
        orderBy: { createdAt: "desc" },
    });
    return { hotel, subscription };
}
// ── Admin analytics ────────────────────────────────────────────────────────────
async function getAdminBillingAnalytics() {
    // MRR = sum of plan prices for active-subscription hotels
    const activeHotels = await connect_1.default.hotel.findMany({
        where: { subscriptionStatus: "active" },
        include: { plan: true },
    });
    const mrr = activeHotels.reduce((sum, h) => sum + (h.plan?.priceMonthly ?? 0), 0);
    // MRR trend: use subscriptions grouped by month (start of billing period)
    // Gives a picture of when hotels were activated
    const subHistory = await connect_1.default.subscription.findMany({
        orderBy: { startDate: "asc" },
        select: { price: true, startDate: true },
    });
    // Build monthly MRR from subscription activations (cumulative running total)
    const monthMap = new Map();
    for (const sub of subHistory) {
        const m = `${sub.startDate.getFullYear()}-${String(sub.startDate.getMonth() + 1).padStart(2, "0")}`;
        monthMap.set(m, (monthMap.get(m) ?? 0) + sub.price);
    }
    const mrrHistory = [...monthMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-6)
        .map(([month, total]) => ({ month, mrr: total }));
    return {
        mrr,
        activeHotelsCount: activeHotels.length,
        mrrHistory,
    };
}
// ── Check and expire subscriptions ────────────────────────────────────────────
// Call this from a scheduled job
async function expireOverdueSubscriptions() {
    const now = new Date();
    const result = await connect_1.default.hotel.updateMany({
        where: {
            subscriptionStatus: "active",
            billingEndDate: { lt: now },
        },
        data: { subscriptionStatus: "expired" },
    });
    return result.count;
}
//# sourceMappingURL=billing.service.js.map