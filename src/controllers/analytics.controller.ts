import { Request, Response } from "express";
import { SubscriptionStatus } from "@prisma/client";
import { getAdminBillingAnalytics, getBillingConfig } from "../services/billing.service";
import { getPlatformUsageThisMonth, getPlatformUsageHistory } from "../services/usage.service";
import { monthKey } from "../billing/period";
import { serverError } from "../utils/serverError";
import prisma from "../db/connect";

// GET /admin/analytics
export async function getAnalytics(req: Request, res: Response) {
  try {
    const [billing, usageNow, usageHistory, hotelStats] = await Promise.all([
      getAdminBillingAnalytics(),
      getPlatformUsageThisMonth(),
      getPlatformUsageHistory(6),
      prisma.hotel.groupBy({ by: ["subscriptionStatus"], _count: true }),
    ]);

    const statusMap = Object.fromEntries(hotelStats.map((s) => [s.subscriptionStatus, s._count]));

    res.json({
      // MRR is now a { currency: minorUnits } map read from subscription
      // snapshots. It used to be one number summing mixed-currency plan prices,
      // which the UI then rendered with a hardcoded "$".
      mrr: billing.mrr,
      paidHotels: billing.paidHotels,
      currencies: billing.currencies,
      activeHotels: billing.activeHotelsCount,
      trialHotels: statusMap[SubscriptionStatus.TRIALING] ?? 0,
      pastDueHotels: statusMap[SubscriptionStatus.PAST_DUE] ?? 0,
      expiredHotels: statusMap[SubscriptionStatus.EXPIRED] ?? 0,
      canceledHotels: statusMap[SubscriptionStatus.CANCELED] ?? 0,
      conversations: usageNow.conversations,
      aiReplies: usageNow.aiReplies,
      // Derived from issued invoices. The old series grouped subscriptions by
      // startDate month, which measured "value of subscriptions STARTED in
      // month X" — a hotel that hadn't changed plan in three months contributed
      // zero to those months.
      mrrHistory: billing.mrrHistory,
      usageHistory,
    });
  } catch (err) {
    return serverError(res, err, "Failed to load analytics");
  }
}

// GET /admin/hotels-billing
export async function listHotelsWithBilling(req: Request, res: Response) {
  try {
    const page = Math.max(1, Number(req.query["page"]) || 1);
    const limit = Math.min(50, Number(req.query["limit"]) || 20);
    const skip = (page - 1) * limit;
    const status = String(req.query["status"] ?? "").toUpperCase();

    const where =
      status && status in SubscriptionStatus
        ? { subscriptionStatus: status as SubscriptionStatus }
        : {};

    const [hotels, total] = await Promise.all([
      prisma.hotel.findMany({
        where,
        skip,
        take: limit,
        include: { plan: true, _count: { select: { users: true, bookings: true, guests: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.hotel.count({ where }),
    ]);

    const { timezone } = await getBillingConfig();
    const month = monthKey(new Date(), timezone);
    const hotelIds = hotels.map((h) => h.id);

    // The row's plan may have been edited since assignment — the SNAPSHOT is
    // what the hotel is actually billed, so surface both.
    const [usages, subs] = await Promise.all([
      prisma.usageRecord.findMany({ where: { hotelId: { in: hotelIds }, month } }),
      prisma.subscription.findMany({
        where: {
          hotelId: { in: hotelIds },
          status: { in: [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
        },
        select: { hotelId: true, planName: true, price: true, currency: true, endDate: true, autoRenew: true },
      }),
    ]);

    const usageMap = Object.fromEntries(usages.map((u) => [u.hotelId, u]));
    const subMap = Object.fromEntries(subs.map((s) => [s.hotelId, s]));

    const data = hotels.map((h) => ({
      ...h,
      usage: usageMap[h.id] ?? { conversationsUsed: 0, aiRepliesUsed: 0 },
      subscription: subMap[h.id] ?? null,
    }));

    res.json({ data, total, page, pages: Math.ceil(total / limit), limit });
  } catch (err) {
    return serverError(res, err, "Failed to load hotel billing");
  }
}
