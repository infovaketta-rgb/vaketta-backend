"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateBookingService = updateBookingService;
exports.createBookingService = createBookingService;
const connect_1 = __importDefault(require("../db/connect"));
const client_1 = require("@prisma/client");
async function updateBookingService({ id, hotelId, guestName, roomTypeId, checkIn, checkOut, pricePerNight, advancePaid, }) {
    const booking = await connect_1.default.booking.findFirst({ where: { id, hotelId } });
    if (!booking)
        throw new Error("Booking not found");
    const finalCheckIn = checkIn ? new Date(checkIn) : booking.checkIn;
    const finalCheckOut = checkOut ? new Date(checkOut) : booking.checkOut;
    if (finalCheckOut <= finalCheckIn)
        throw new Error("Check-out must be after check-in");
    const nights = Math.ceil((finalCheckOut.getTime() - finalCheckIn.getTime()) / (1000 * 60 * 60 * 24));
    const finalPrice = pricePerNight ?? booking.pricePerNight;
    const totalPrice = nights * finalPrice;
    return connect_1.default.booking.update({
        where: { id },
        data: {
            ...(guestName ? { guestName } : {}),
            ...(roomTypeId ? { roomTypeId } : {}),
            checkIn: finalCheckIn,
            checkOut: finalCheckOut,
            pricePerNight: finalPrice,
            totalPrice,
            ...(advancePaid !== undefined ? { advancePaid } : {}),
        },
        include: { guest: true, roomType: true },
    });
}
async function createBookingService({ hotelId, guestId, guestName, roomTypeId, checkIn, checkOut, pricePerNight, advancePaid // optional override
 }) {
    const roomType = await connect_1.default.roomType.findFirst({
        where: { id: roomTypeId, hotelId },
    });
    if (!roomType) {
        throw new Error("Room type not found");
    }
    const finalPrice = pricePerNight ?? roomType.basePrice;
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    if (checkOutDate <= checkInDate) {
        throw new Error("Check-out must be after check-in");
    }
    const nights = Math.ceil((checkOutDate.getTime() - checkInDate.getTime()) /
        (1000 * 60 * 60 * 24));
    const totalPrice = nights * finalPrice;
    // Update guest name if needed
    if (guestName) {
        await connect_1.default.guest.updateMany({
            where: { id: guestId, hotelId },
            data: { name: guestName },
        });
    }
    return connect_1.default.booking.create({
        data: {
            hotelId,
            guestId,
            roomTypeId,
            guestName,
            checkIn: new Date(checkIn),
            checkOut: new Date(checkOut),
            pricePerNight: finalPrice,
            totalPrice,
            advancePaid: advancePaid ?? 0,
            status: client_1.BookingStatus.PENDING,
        },
        include: { guest: true, roomType: true },
    });
}
//# sourceMappingURL=booking.service.js.map