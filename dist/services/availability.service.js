"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCalendarData = getCalendarData;
exports.upsertInventoryCell = upsertInventoryCell;
exports.bulkUpsertInventory = bulkUpsertInventory;
exports.checkRoomAvailability = checkRoomAvailability;
exports.getAvailabilityEnabled = getAvailabilityEnabled;
exports.setAvailabilityEnabled = setAvailabilityEnabled;
const connect_1 = __importDefault(require("../db/connect"));
// ── Date helpers ───────────────────────────────────────────────────────────────
/** Parse an ISO date string (YYYY-MM-DD) and return a UTC-midnight Date. */
function toUtcDate(d) {
    if (d instanceof Date) {
        const r = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        return r;
    }
    const [y, m, day] = d.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, day));
}
function addDays(d, n) {
    return new Date(d.getTime() + n * 86400000);
}
/** Expand [start, end) into an array of UTC-midnight Dates (nights). */
function nightRange(start, end) {
    const nights = [];
    let cur = start;
    while (cur < end) {
        nights.push(cur);
        cur = addDays(cur, 1);
    }
    return nights;
}
// ── Calendar query ─────────────────────────────────────────────────────────────
async function getCalendarData(hotelId, startDate, endDate) {
    const start = toUtcDate(startDate);
    const end = toUtcDate(endDate);
    const nights = nightRange(start, end);
    const dateStrs = nights.map((d) => d.toISOString().slice(0, 10));
    const [roomTypes, inventoryRows, bookings] = await Promise.all([
        connect_1.default.roomType.findMany({
            where: { hotelId },
            orderBy: { createdAt: "asc" },
            select: { id: true, name: true, basePrice: true, totalRooms: true },
        }),
        connect_1.default.roomInventory.findMany({
            where: {
                hotelId,
                date: { gte: start, lte: addDays(end, -1) },
            },
        }),
        connect_1.default.booking.findMany({
            where: {
                hotelId,
                status: { notIn: ["CANCELLED"] },
                checkIn: { lt: end },
                checkOut: { gt: start },
            },
            select: { roomTypeId: true, checkIn: true, checkOut: true },
        }),
    ]);
    // Index inventory by roomTypeId + dateStr
    const invMap = {};
    for (const row of inventoryRows) {
        const rid = row.roomTypeId;
        const ds = row.date.toISOString().slice(0, 10);
        if (!invMap[rid])
            invMap[rid] = {};
        invMap[rid][ds] = { availableRooms: row.availableRooms, price: row.price };
    }
    // Count booked rooms per roomType per night
    const bookedMap = {};
    for (const b of bookings) {
        const ci = toUtcDate(b.checkIn);
        const co = toUtcDate(b.checkOut);
        for (const night of nightRange(ci, co)) {
            const ds = night.toISOString().slice(0, 10);
            if (!dateStrs.includes(ds))
                continue;
            if (!bookedMap[b.roomTypeId])
                bookedMap[b.roomTypeId] = {};
            bookedMap[b.roomTypeId][ds] = (bookedMap[b.roomTypeId][ds] ?? 0) + 1;
        }
    }
    // Build cell grid
    const cells = {};
    for (const rt of roomTypes) {
        cells[rt.id] = {};
        for (const ds of dateStrs) {
            const inv = invMap[rt.id]?.[ds];
            const booked = bookedMap[rt.id]?.[ds] ?? 0;
            const total = rt.totalRooms;
            const isOverridden = inv !== undefined;
            const available = isOverridden
                ? inv.availableRooms
                : Math.max(0, total - booked);
            const price = inv?.price ?? rt.basePrice;
            cells[rt.id][ds] = { availableRooms: available, totalRooms: total, bookedRooms: booked, price, isOverridden };
        }
    }
    return { roomTypes, dates: dateStrs, cells };
}
// ── Single cell upsert ─────────────────────────────────────────────────────────
async function upsertInventoryCell(hotelId, roomTypeId, date, availableRooms, price) {
    const rt = await connect_1.default.roomType.findFirst({ where: { id: roomTypeId, hotelId } });
    if (!rt)
        throw new Error("Room type not found");
    if (availableRooms < 0 || availableRooms > rt.totalRooms) {
        throw new Error(`availableRooms must be 0–${rt.totalRooms}`);
    }
    const d = toUtcDate(date);
    return connect_1.default.roomInventory.upsert({
        where: { roomTypeId_date: { roomTypeId, date: d } },
        update: { availableRooms, price: price ?? null },
        create: { hotelId, roomTypeId, date: d, availableRooms, price: price ?? null },
    });
}
// ── Bulk upsert ────────────────────────────────────────────────────────────────
async function bulkUpsertInventory(hotelId, roomTypeId, startDate, endDate, availableRooms, price) {
    const rt = await connect_1.default.roomType.findFirst({ where: { id: roomTypeId, hotelId } });
    if (!rt)
        throw new Error("Room type not found");
    if (availableRooms < 0 || availableRooms > rt.totalRooms) {
        throw new Error(`availableRooms must be 0–${rt.totalRooms}`);
    }
    const nights = nightRange(toUtcDate(startDate), toUtcDate(endDate));
    if (nights.length > 365)
        throw new Error("Range must not exceed 365 days");
    await Promise.all(nights.map((d) => connect_1.default.roomInventory.upsert({
        where: { roomTypeId_date: { roomTypeId, date: d } },
        update: { availableRooms, price: price ?? null },
        create: { hotelId, roomTypeId, date: d, availableRooms, price: price ?? null },
    })));
    return { updated: nights.length };
}
// ── Bot availability check ─────────────────────────────────────────────────────
async function checkRoomAvailability(hotelId, roomTypeId, checkIn, checkOut) {
    const ci = toUtcDate(checkIn);
    const co = toUtcDate(checkOut);
    const nights = nightRange(ci, co);
    if (!nights.length)
        return { available: false, availableCount: 0 };
    const [rt, inventoryRows, bookings] = await Promise.all([
        connect_1.default.roomType.findUnique({ where: { id: roomTypeId }, select: { totalRooms: true } }),
        connect_1.default.roomInventory.findMany({
            where: { roomTypeId, date: { gte: ci, lt: co } },
            select: { date: true, availableRooms: true },
        }),
        connect_1.default.booking.findMany({
            where: {
                hotelId,
                roomTypeId,
                status: { notIn: ["CANCELLED"] },
                checkIn: { lt: co },
                checkOut: { gt: ci },
            },
            select: { checkIn: true, checkOut: true },
        }),
    ]);
    if (!rt)
        return { available: false, availableCount: 0 };
    const invByDate = {};
    for (const row of inventoryRows) {
        invByDate[row.date.toISOString().slice(0, 10)] = row.availableRooms;
    }
    // Count bookings per night
    const bookedByDate = {};
    for (const b of bookings) {
        for (const night of nightRange(toUtcDate(b.checkIn), toUtcDate(b.checkOut))) {
            const ds = night.toISOString().slice(0, 10);
            bookedByDate[ds] = (bookedByDate[ds] ?? 0) + 1;
        }
    }
    let minAvailable = Infinity;
    for (const night of nights) {
        const ds = night.toISOString().slice(0, 10);
        const cap = invByDate[ds] !== undefined ? invByDate[ds] : rt.totalRooms;
        const booked = bookedByDate[ds] ?? 0;
        const avail = Math.max(0, cap - booked);
        if (avail < minAvailable)
            minAvailable = avail;
    }
    const availableCount = minAvailable === Infinity ? rt.totalRooms : minAvailable;
    return { available: availableCount > 0, availableCount };
}
// ── Availability toggle ────────────────────────────────────────────────────────
async function getAvailabilityEnabled(hotelId) {
    const config = await connect_1.default.hotelConfig.findUnique({ where: { hotelId } });
    return config?.availabilityEnabled ?? false;
}
async function setAvailabilityEnabled(hotelId, enabled) {
    await connect_1.default.hotelConfig.upsert({
        where: { hotelId },
        update: { availabilityEnabled: enabled },
        create: { hotelId, availabilityEnabled: enabled },
    });
}
//# sourceMappingURL=availability.service.js.map