import prisma from "../db/connect";
import { BookingStatus } from "@prisma/client";
import { checkRoomAvailability } from "./availability.service";
import { generateReferenceNumber } from "../utils/booking.utils";
import { emitToHotel } from "../realtime/emit";



export async function updateBookingService({
  id,
  hotelId,
  guestName,
  roomTypeId,
  checkIn,
  checkOut,
  pricePerNight,
  advancePaid,
}: {
  id: string;
  hotelId: string;
  guestName?: string;
  roomTypeId?: string;
  checkIn?: string;
  checkOut?: string;
  pricePerNight?: number;
  advancePaid?: number;
}) {
  const booking = await prisma.booking.findFirst({ where: { id, hotelId } });
  if (!booking) throw new Error("Booking not found");

  const finalCheckIn  = checkIn  ? new Date(checkIn)  : booking.checkIn;
  const finalCheckOut = checkOut ? new Date(checkOut) : booking.checkOut;
  const finalRoomTypeId = roomTypeId ?? booking.roomTypeId;

  const MS_PER_DAY   = 24 * 60 * 60 * 1000;
  const checkInDay   = Math.floor(finalCheckIn.getTime()  / MS_PER_DAY) * MS_PER_DAY;
  const checkOutDay  = Math.floor(finalCheckOut.getTime() / MS_PER_DAY) * MS_PER_DAY;
  const nights       = Math.floor((checkOutDay - checkInDay) / MS_PER_DAY);

  if (nights < 1) throw new Error("Check-out must be at least 1 day after check-in");

  const finalPrice = pricePerNight ?? booking.pricePerNight;
  const totalPrice = nights * finalPrice;

  // Availability check when dates or room type changed — exclude the current booking from count
  const datesOrRoomChanged = checkIn || checkOut || roomTypeId;
  if (datesOrRoomChanged) {
    const config = await prisma.hotelConfig.findUnique({
      where:  { hotelId },
      select: { availabilityEnabled: true },
    });
    if (config?.availabilityEnabled) {
      const { availableCount } = await checkRoomAvailability(hotelId, finalRoomTypeId, finalCheckIn, finalCheckOut);
      // Count must be > 0 because the current booking is still occupying a slot
      // (it hasn't been cancelled yet, so we need at least 1 for itself)
      if (availableCount < 1) {
        throw new Error("Room is not available for the selected dates");
      }
    }
  }

  return prisma.booking.update({
    where: { id },
    data: {
      ...(guestName ? { guestName } : {}),
      ...(roomTypeId ? { roomTypeId: finalRoomTypeId } : {}),
      checkIn: finalCheckIn,
      checkOut: finalCheckOut,
      pricePerNight: finalPrice,
      totalPrice,
      ...(advancePaid !== undefined ? { advancePaid } : {}),
    },
    include: { guest: true, roomType: true },
  });
}


export async function createBookingService({
  hotelId,
  guestId,
  guestName,
  roomTypeId,
  checkIn,
  checkOut,
  pricePerNight,
  advancePaid // optional override
}: {
  hotelId: string;
  guestId: string;
  guestName: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  pricePerNight?: number;
  advancePaid?:number;
}) {
  const roomType = await prisma.roomType.findFirst({
    where: { id: roomTypeId, hotelId },
  });

  if (!roomType) {
    throw new Error("Room type not found");
  }

  const finalPrice = pricePerNight ?? roomType.basePrice;

const checkInDate = new Date(checkIn);
const checkOutDate = new Date(checkOut);

if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
  throw new Error("Invalid check-in or check-out date");
}

const MS_PER_DAY  = 24 * 60 * 60 * 1000;
const checkInDay  = Math.floor(checkInDate.getTime()  / MS_PER_DAY) * MS_PER_DAY;
const checkOutDay = Math.floor(checkOutDate.getTime() / MS_PER_DAY) * MS_PER_DAY;
const nights      = Math.floor((checkOutDay - checkInDay) / MS_PER_DAY);

if (nights < 1) {
  throw new Error("Check-out must be at least 1 day after check-in");
}


  const totalPrice = nights * finalPrice;

  // Availability check — prevent overbooking
  const config = await prisma.hotelConfig.findUnique({ where: { hotelId }, select: { availabilityEnabled: true } });
  if (config?.availabilityEnabled) {
    const { available } = await checkRoomAvailability(hotelId, roomTypeId, checkInDate, checkOutDate);
    if (!available) {
      throw new Error("Room is not available for the selected dates");
    }
  }

  // Update guest name if needed
  if (guestName) {
    await prisma.guest.updateMany({
      where: { id: guestId, hotelId },
      data:  { name: guestName },
    });
  }

  const lockKey = `${hotelId}:${new Date().getFullYear()}`;

  const booking = await prisma.$transaction(async (tx) => {
    // Per-hotel-per-year advisory lock — serializes concurrent ref generation.
    // Transaction-scoped: auto-released on commit or rollback.
    // hashtext() → int4, auto-promoted to bigint by Postgres.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const referenceNumber = await generateReferenceNumber(tx);
    return tx.booking.create({
      data: {
        hotelId,
        guestId,
        roomTypeId,
        guestName,
        referenceNumber,
        checkIn:       checkInDate,
        checkOut:      checkOutDate,
        pricePerNight: finalPrice,
        totalPrice,
        advancePaid:   advancePaid ?? 0,
        status:        BookingStatus.PENDING,
      },
      include: { guest: true, roomType: true },
    });
  });

  emitToHotel(hotelId, "booking:new", { booking });

  return booking;
}

export async function cancelBooking(bookingId: string, hotelId: string) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, hotelId } });
  if (!booking) throw new Error("Booking not found");
  if (booking.status === BookingStatus.CANCELLED) {
    throw new Error("This booking has already been cancelled.");
  }

  return prisma.booking.update({
    where: { id: bookingId },
    data:  { status: BookingStatus.CANCELLED },
  });
}
