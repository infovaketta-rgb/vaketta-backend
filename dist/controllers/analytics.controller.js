"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAnalytics = getAnalytics;
exports.listHotelsWithBilling = listHotelsWithBilling;
const billing_service_1 = require("../services/billing.service");
const usage_service_1 = require("../services/usage.service");
const connect_1 = __importDefault(require("../db/connect"));
// GET /admin/analytics
async function getAnalytics(req, res) {
    try {
        const [billing, usageNow, usageHistory, hotelStats] = await Promise.all([
            (0, billing_service_1.getAdminBillingAnalytics)(),
            (0, usage_service_1.getPlatformUsageThisMonth)(),
            (0, usage_service_1.getPlatformUsageHistory)(6),
            connect_1.default.hotel.groupBy({
                by: ["subscriptionStatus"],
                _count: true,
            }),
        ]);
        const statusMap = Object.fromEntries(hotelStats.map((s) => [s.subscriptionStatus, s._count]));
        res.json({
            mrr: billing.mrr,
            activeHotels: billing.activeHotelsCount,
            trialHotels: statusMap["trial"] ?? 0,
            expiredHotels: statusMap["expired"] ?? 0,
            conversations: usageNow.conversations,
            aiReplies: usageNow.aiReplies,
            mrrHistory: billing.mrrHistory,
            usageHistory,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
// GET /admin/hotels  (extended with plan + usage)
async function listHotelsWithBilling(req, res) {
    try {
        const page = Math.max(1, Number(req.query["page"]) || 1);
        const limit = Math.min(50, Number(req.query["limit"]) || 20);
        const skip = (page - 1) * limit;
        const [hotels, total] = await Promise.all([
            connect_1.default.hotel.findMany({
                skip,
                take: limit,
                include: { plan: true, _count: { select: { users: true, bookings: true, guests: true } } },
                orderBy: { createdAt: "desc" },
            }),
            connect_1.default.hotel.count(),
        ]);
        // Attach current month usage
        const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
        const hotelIds = hotels.map((h) => h.id);
        const usages = await connect_1.default.usageRecord.findMany({
            where: { hotelId: { in: hotelIds }, month },
        });
        const usageMap = Object.fromEntries(usages.map((u) => [u.hotelId, u]));
        const data = hotels.map((h) => ({
            ...h,
            usage: usageMap[h.id] ?? { conversationsUsed: 0, aiRepliesUsed: 0 },
        }));
        res.json({ data, total, page, pages: Math.ceil(total / limit), limit });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
//# sourceMappingURL=analytics.controller.js.map