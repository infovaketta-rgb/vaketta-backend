import { Request, Response } from "express";
import { getAdminBillingAnalytics } from "../services/billing.service";
import {
  getPlatformUsageThisMonth,
  getPlatformUsageHistory,
} from "../services/usage.service";
import prisma from "../db/connect";

// GET /admin/analytics
export async function getAnalytics(req: Request, res: Response) {
  try {
    const [billing, usageNow, usageHistory, hotelStats] = await Promise.all([
      getAdminBillingAnalytics(),
      getPlatformUsageThisMonth(),
      getPlatformUsageHistory(6),
      prisma.hotel.groupBy({
        by:    ["subscriptionStatus"],
        _count: true,
      }),
    ]);

    const statusMap = Object.fromEntries(
      hotelStats.map((s) => [s.subscriptionStatus, s._count])
    );

    res.json({
      mrr:              billing.mrr,
      activeHotels:     billing.activeHotelsCount,
      trialHotels:      statusMap["trial"]   ?? 0,
      expiredHotels:    statusMap["expired"] ?? 0,
      conversations:    usageNow.conversations,
      aiReplies:        usageNow.aiReplies,
      mrrHistory:       billing.mrrHistory,
      usageHistory,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /admin/hotels  (extended with plan + usage)
export async function listHotelsWithBilling(req: Request, res: Response) {
  try {
    const page  = Math.max(1, Number(req.query["page"])  || 1);
    const limit = Math.min(50, Number(req.query["limit"]) || 20);
    const skip  = (page - 1) * limit;

    const [hotels, total] = await Promise.all([
      prisma.hotel.findMany({
        skip,
        take:    limit,
        include: { plan: true, _count: { select: { users: true, bookings: true, guests: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.hotel.count(),
    ]);

    // Attach current month usage
    const month    = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    const hotelIds = hotels.map((h) => h.id);
    const usages   = await prisma.usageRecord.findMany({
      where: { hotelId: { in: hotelIds }, month },
    });
    const usageMap = Object.fromEntries(usages.map((u) => [u.hotelId, u]));

    const data = hotels.map((h) => ({
      ...h,
      usage: usageMap[h.id] ?? { conversationsUsed: 0, aiRepliesUsed: 0 },
    }));

    res.json({ data, total, page, pages: Math.ceil(total / limit), limit });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
