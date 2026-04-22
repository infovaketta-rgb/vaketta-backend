import prisma from "../db/connect";
import { BookingStatus } from "@prisma/client";

export type StatWithTrend = {
  value: number;
  trendPercent: number | null;
};

export type DashboardResponse = {
  stats: {
    todayRevenue: StatWithTrend;
    totalBookings: StatWithTrend;
    activeGuests24h: StatWithTrend;
    pendingBookings: StatWithTrend;
  };
  revenueLast7Days: { date: string; revenue: number }[];
  bookingsLast7Days: { date: string; count: number }[];
  recentBookings: {
    id: string;
    guestName: string;
    roomTypeName: string;
    checkIn: string;
    checkOut: string;
    totalPrice: number;
    status: BookingStatus;
  }[];
};

function startOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function endOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
}

function addUtcDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function formatDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function sumConfirmedRevenueInRange(
  hotelId: string,
  from: Date,
  to: Date
): Promise<number> {
  const agg = await prisma.booking.aggregate({
    where: {
      hotelId,
      status: BookingStatus.CONFIRMED,
      createdAt: { gte: from, lte: to },
    },
    _sum: { totalPrice: true },
  });
  return Number(agg._sum.totalPrice ?? 0);
}

export async function getDashboardData(hotelId: string): Promise<DashboardResponse> {
  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const todayEnd = endOfUtcDay(now);
  const yesterdayStart = startOfUtcDay(addUtcDays(now, -1));
  const yesterdayEnd = endOfUtcDay(addUtcDays(now, -1));
  const sevenDaysAgo = addUtcDays(todayStart, -7);
  const fourteenDaysAgo = addUtcDays(todayStart, -14);
  const day24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const day48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  // All 10 independent queries run in parallel — reduces wall-clock time from ~10x serial to 1x
  const [
    todayRevenue,
    yesterdayRevenue,
    totalBookingsCount,
    bookingsLast7d,
    bookingsPrev7d,
    activeGuestsRows,
    activeGuestsPrevRows,
    pendingBookings,
    pendingCreatedLast7d,
    pendingCreatedPrev7d,
    confirmedLast7,
    allLast7,
    recent,
  ] = await Promise.all([
    sumConfirmedRevenueInRange(hotelId, todayStart, todayEnd),
    sumConfirmedRevenueInRange(hotelId, yesterdayStart, yesterdayEnd),
    prisma.booking.count({ where: { hotelId } }),
    prisma.booking.count({ where: { hotelId, createdAt: { gte: sevenDaysAgo } } }),
    prisma.booking.count({ where: { hotelId, createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo } } }),
    prisma.message.groupBy({
      by: ["guestId"],
      where: { hotelId, guestId: { not: null }, timestamp: { gte: day24h } },
    }),
    prisma.message.groupBy({
      by: ["guestId"],
      where: { hotelId, guestId: { not: null }, timestamp: { gte: day48h, lt: day24h } },
    }),
    prisma.booking.count({ where: { hotelId, status: BookingStatus.PENDING } }),
    prisma.booking.count({ where: { hotelId, status: BookingStatus.PENDING, createdAt: { gte: sevenDaysAgo } } }),
    prisma.booking.count({ where: { hotelId, status: BookingStatus.PENDING, createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo } } }),
    prisma.booking.findMany({
      where: { hotelId, status: BookingStatus.CONFIRMED, createdAt: { gte: sevenDaysAgo, lte: todayEnd } },
      select: { createdAt: true, totalPrice: true },
    }),
    prisma.booking.findMany({
      where: { hotelId, createdAt: { gte: sevenDaysAgo, lte: todayEnd } },
      select: { createdAt: true },
    }),
    prisma.booking.findMany({
      where: { hotelId },
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { roomType: { select: { name: true } } },
    }),
  ]);

  const activeGuests24h     = activeGuestsRows.filter((r) => r.guestId).length;
  const activeGuestsPrev24h = activeGuestsPrevRows.filter((r) => r.guestId).length;

  // Build day-keyed maps
  const revenueByDay = new Map<string, number>();
  const countByDay   = new Map<string, number>();

  for (const b of confirmedLast7) {
    const key = formatDateKey(startOfUtcDay(b.createdAt));
    revenueByDay.set(key, (revenueByDay.get(key) ?? 0) + Number(b.totalPrice));
  }
  for (const b of allLast7) {
    const key = formatDateKey(startOfUtcDay(b.createdAt));
    countByDay.set(key, (countByDay.get(key) ?? 0) + 1);
  }

  // Fill all 7 slots (including days with zero activity)
  const revenueLast7Days: { date: string; revenue: number }[] = [];
  const bookingsLast7Days: { date: string; count: number }[] = [];

  for (let i = 6; i >= 0; i--) {
    const key = formatDateKey(startOfUtcDay(addUtcDays(now, -i)));
    revenueLast7Days.push({ date: key, revenue: revenueByDay.get(key) ?? 0 });
    bookingsLast7Days.push({ date: key, count: countByDay.get(key) ?? 0 });
  }

  const recentBookings = recent.map((b) => ({
    id: b.id,
    guestName: b.guestName,
    roomTypeName: b.roomType.name,
    checkIn: b.checkIn.toISOString(),
    checkOut: b.checkOut.toISOString(),
    totalPrice: b.totalPrice,
    status: b.status,
  }));

  return {
    stats: {
      todayRevenue: {
        value: todayRevenue,
        trendPercent: pctChange(todayRevenue, yesterdayRevenue),
      },
      totalBookings: {
        value: totalBookingsCount,
        trendPercent: pctChange(bookingsLast7d, bookingsPrev7d),
      },
      activeGuests24h: {
        value: activeGuests24h,
        trendPercent: pctChange(activeGuests24h, activeGuestsPrev24h),
      },
      pendingBookings: {
        value: pendingBookings,
        trendPercent: pctChange(pendingCreatedLast7d, pendingCreatedPrev7d),
      },
    },
    revenueLast7Days,
    bookingsLast7Days,
    recentBookings,
  };
}
