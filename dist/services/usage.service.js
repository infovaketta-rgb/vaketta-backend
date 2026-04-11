"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.currentMonth = currentMonth;
exports.incrementConversationUsage = incrementConversationUsage;
exports.incrementAIUsage = incrementAIUsage;
exports.getCurrentUsage = getCurrentUsage;
exports.getUsageHistory = getUsageHistory;
exports.getPlatformUsageThisMonth = getPlatformUsageThisMonth;
exports.getPlatformUsageHistory = getPlatformUsageHistory;
const connect_1 = __importDefault(require("../db/connect"));
function currentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
// ── Increment ──────────────────────────────────────────────────────────────────
async function incrementConversationUsage(hotelId) {
    const month = currentMonth();
    await connect_1.default.usageRecord.upsert({
        where: { hotelId_month: { hotelId, month } },
        update: { conversationsUsed: { increment: 1 } },
        create: { hotelId, month, conversationsUsed: 1, aiRepliesUsed: 0 },
    });
}
async function incrementAIUsage(hotelId) {
    const month = currentMonth();
    await connect_1.default.usageRecord.upsert({
        where: { hotelId_month: { hotelId, month } },
        update: { aiRepliesUsed: { increment: 1 } },
        create: { hotelId, month, conversationsUsed: 0, aiRepliesUsed: 1 },
    });
}
// ── Read ───────────────────────────────────────────────────────────────────────
async function getCurrentUsage(hotelId) {
    const month = currentMonth();
    return ((await connect_1.default.usageRecord.findUnique({
        where: { hotelId_month: { hotelId, month } },
    })) ?? { hotelId, month, conversationsUsed: 0, aiRepliesUsed: 0 });
}
async function getUsageHistory(hotelId, months = 6) {
    const records = await connect_1.default.usageRecord.findMany({
        where: { hotelId },
        orderBy: { month: "desc" },
        take: months,
    });
    return records.reverse(); // oldest → newest for charts
}
// ── Admin aggregates ───────────────────────────────────────────────────────────
async function getPlatformUsageThisMonth() {
    const month = currentMonth();
    const agg = await connect_1.default.usageRecord.aggregate({
        where: { month },
        _sum: { conversationsUsed: true, aiRepliesUsed: true },
    });
    return {
        conversations: agg._sum.conversationsUsed ?? 0,
        aiReplies: agg._sum.aiRepliesUsed ?? 0,
    };
}
async function getPlatformUsageHistory(months = 6) {
    // Collect last N distinct months across all hotels
    const records = await connect_1.default.usageRecord.groupBy({
        by: ["month"],
        _sum: { conversationsUsed: true, aiRepliesUsed: true },
        orderBy: { month: "asc" },
        take: months * 10, // over-fetch; will slice after
    });
    // Get the last `months` unique months
    const unique = [...new Map(records.map((r) => [r.month, r])).values()];
    return unique.slice(-months).map((r) => ({
        month: r.month,
        conversations: r._sum.conversationsUsed ?? 0,
        aiReplies: r._sum.aiRepliesUsed ?? 0,
    }));
}
//# sourceMappingURL=usage.service.js.map