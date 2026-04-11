"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDashboardData = getDashboardData;
const connect_1 = __importDefault(require("../db/connect"));
const client_1 = require("@prisma/client");
function startOfUtcDay(d) {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    return x;
}
function endOfUtcDay(d) {
    const x = new Date(d);
    x.setUTCHours(23, 59, 59, 999);
    return x;
}
function addUtcDays(d, days) {
    const x = new Date(d);
    x.setUTCDate(x.getUTCDate() + days);
    return x;
}
function formatDateKey(d) {
    return d.toISOString().slice(0, 10);
}
function pctChange(current, previous) {
    if (previous === 0 && current === 0)
        return 0;
    if (previous === 0)
        return null;
    return Math.round(((current - previous) / previous) * 1000) / 10;
}
async function sumConfirmedRevenueInRange(hotelId, from, to) {
    const agg = await connect_1.default.booking.aggregate({
        where: {
            hotelId,
            status: client_1.BookingStatus.CONFIRMED,
            createdAt: { gte: from, lte: to },
        },
        _sum: { totalPrice: true },
    });
    return Number(agg._sum.totalPrice ?? 0);
}
async function getDashboardData(hotelId) {
    const now = new Date();
    const todayStart = startOfUtcDay(now);
    const todayEnd = endOfUtcDay(now);
    const yesterdayStart = startOfUtcDay(addUtcDays(now, -1));
    const yesterdayEnd = endOfUtcDay(addUtcDays(now, -1));
    const todayRevenue = await sumConfirmedRevenueInRange(hotelId, todayStart, todayEnd);
    const yesterdayRevenue = await sumConfirmedRevenueInRange(hotelId, yesterdayStart, yesterdayEnd);
    const totalBookingsCount = await connect_1.default.booking.count({ where: { hotelId } });
    const sevenDaysAgo = addUtcDays(todayStart, -7);
    const fourteenDaysAgo = addUtcDays(todayStart, -14);
    const bookingsLast7d = await connect_1.default.booking.count({
        where: {
            hotelId,
            createdAt: { gte: sevenDaysAgo },
        },
    });
    const bookingsPrev7d = await connect_1.default.booking.count({
        where: {
            hotelId,
            createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
        },
    });
    const day24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const day48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const activeGuestsRows = await connect_1.default.message.groupBy({
        by: ["guestId"],
        where: {
            hotelId,
            guestId: { not: null },
            timestamp: { gte: day24h },
        },
    });
    const activeGuests24h = activeGuestsRows.filter((r) => r.guestId).length;
    const activeGuestsPrevRows = await connect_1.default.message.groupBy({
        by: ["guestId"],
        where: {
            hotelId,
            guestId: { not: null },
            timestamp: { gte: day48h, lt: day24h },
        },
    });
    const activeGuestsPrev24h = activeGuestsPrevRows.filter((r) => r.guestId).length;
    const pendingBookings = await connect_1.default.booking.count({
        where: { hotelId, status: client_1.BookingStatus.PENDING },
    });
    const pendingCreatedLast7d = await connect_1.default.booking.count({
        where: {
            hotelId,
            status: client_1.BookingStatus.PENDING,
            createdAt: { gte: sevenDaysAgo },
        },
    });
    const pendingCreatedPrev7d = await connect_1.default.booking.count({
        where: {
            hotelId,
            status: client_1.BookingStatus.PENDING,
            createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
        },
    });
    const revenueLast7Days = [];
    const bookingsLast7Days = [];
    for (let i = 6; i >= 0; i--) {
        const day = startOfUtcDay(addUtcDays(now, -i));
        const dayEndLoop = endOfUtcDay(day);
        const key = formatDateKey(day);
        const revAgg = await connect_1.default.booking.aggregate({
            where: {
                hotelId,
                status: client_1.BookingStatus.CONFIRMED,
                createdAt: { gte: day, lte: dayEndLoop },
            },
            _sum: { totalPrice: true },
        });
        revenueLast7Days.push({
            date: key,
            revenue: Number(revAgg._sum.totalPrice ?? 0),
        });
        const count = await connect_1.default.booking.count({
            where: {
                hotelId,
                createdAt: { gte: day, lte: dayEndLoop },
            },
        });
        bookingsLast7Days.push({ date: key, count });
    }
    const recent = await connect_1.default.booking.findMany({
        where: { hotelId },
        orderBy: { createdAt: "desc" },
        take: 12,
        include: {
            roomType: { select: { name: true } },
        },
    });
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
//# sourceMappingURL=dashboard.service.js.map