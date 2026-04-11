"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBooking = createBooking;
exports.getBookings = getBookings;
exports.updateBookingStatus = updateBookingStatus;
exports.editBooking = editBooking;
exports.getBookingSummary = getBookingSummary;
const booking_service_1 = require("../services/booking.service");
const connect_1 = __importDefault(require("../db/connect"));
const client_1 = require("@prisma/client");
async function createBooking(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const { guestId, guestName, roomTypeId, checkIn, checkOut, pricePerNight, advancePaid, } = req.body;
        if (!guestId || !guestName || !roomTypeId || !checkIn || !checkOut) {
            return res.status(400).json({
                error: "Missing required fields",
            });
        }
        const booking = await (0, booking_service_1.createBookingService)({
            hotelId,
            guestId,
            guestName,
            roomTypeId,
            checkIn,
            checkOut,
            pricePerNight,
            advancePaid,
        });
        res.json(booking);
    }
    catch (err) {
        console.error("❌ Create booking failed", err.message);
        res.status(500).json({ error: "Create booking failed" });
    }
}
async function getBookings(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const bookings = await connect_1.default.booking.findMany({
            where: { hotelId },
            include: {
                guest: true,
                roomType: true,
            },
            orderBy: { createdAt: "desc" },
        });
        return res.json(bookings);
    }
    catch (err) {
        console.error("❌ Get bookings failed:", err);
        return res.status(500).json({ error: "Failed to fetch bookings" });
    }
}
async function updateBookingStatus(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const { bookingId } = req.params;
        const { status } = req.body;
        const validStatuses = Object.values(client_1.BookingStatus);
        if (!bookingId || !status) {
            return res.status(400).json({ error: "bookingId and status required" });
        }
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
        }
        const booking = await connect_1.default.booking.findFirst({
            where: { id: bookingId, hotelId },
        });
        if (!booking) {
            return res.status(404).json({ error: "Booking not found" });
        }
        const updated = await connect_1.default.booking.update({
            where: { id: bookingId, hotelId },
            data: { status },
        });
        res.json(updated);
    }
    catch (err) {
        console.error("Update booking status failed:", err);
        res.status(500).json({ error: "Failed to update status" });
    }
}
async function editBooking(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const { bookingId } = req.params;
        if (!bookingId)
            return res.status(400).json({ error: "bookingId required" });
        const { guestName, roomTypeId, checkIn, checkOut, pricePerNight, advancePaid } = req.body;
        const booking = await (0, booking_service_1.updateBookingService)({
            id: bookingId,
            hotelId,
            guestName,
            roomTypeId,
            checkIn,
            checkOut,
            ...(pricePerNight !== undefined ? { pricePerNight: Number(pricePerNight) } : {}),
            ...(advancePaid !== undefined ? { advancePaid: Number(advancePaid) } : {}),
        });
        res.json(booking);
    }
    catch (err) {
        console.error("Edit booking failed:", err.message);
        res.status(400).json({ error: err.message || "Failed to edit booking" });
    }
}
async function getBookingSummary(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const bookings = await connect_1.default.booking.findMany({
            where: { hotelId, status: client_1.BookingStatus.CONFIRMED },
        });
        const totalRevenue = bookings.reduce((sum, b) => sum + b.totalPrice, 0);
        return res.json({
            totalBookings: bookings.length,
            totalRevenue,
        });
    }
    catch (err) {
        console.error("❌ Summary failed:", err);
        return res.status(500).json({ error: "Failed to fetch summary" });
    }
}
//# sourceMappingURL=booking.controller.js.map