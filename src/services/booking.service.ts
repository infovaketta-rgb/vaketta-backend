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
  rooms,
}: {
  id: string;
  hotelId: string;
  guestName?: string;
  roomTypeId?: string;
  checkIn?: string;
  checkOut?: string;
  pricePerNight?: number;
  advancePaid?: number;
  /** Per-room updates for group bookings. Each entry updates one BookingRoom child. */
  rooms?: Array<{ id: string; roomTypeId?: string; pricePerNight?: number }>;
}) {
  const booking = await prisma.booking.findFirst({
    where:   { id, hotelId },
    include: { rooms: true },
  });
  if (!booking) throw new Error("Booking not found");

  const finalCheckIn    = checkIn  ? new Date(checkIn)  : booking.checkIn;
  const finalCheckOut   = checkOut ? new Date(checkOut) : booking.checkOut;
  const finalRoomTypeId = roomTypeId ?? booking.roomTypeId;

  const MS_PER_DAY  = 24 * 60 * 60 * 1000;
  const checkInDay  = Math.floor(finalCheckIn.getTime()  / MS_PER_DAY) * MS_PER_DAY;
  const checkOutDay = Math.floor(finalCheckOut.getTime() / MS_PER_DAY) * MS_PER_DAY;
  const nights      = Math.floor((checkOutDay - checkInDay) / MS_PER_DAY);

  if (nights < 1) throw new Error("Check-out must be at least 1 day after check-in");

  // Availability check when dates or room type changed
  const datesOrRoomChanged = checkIn || checkOut || roomTypeId;
  if (datesOrRoomChanged) {
    const config = await prisma.hotelConfig.findUnique({
      where:  { hotelId },
      select: { availabilityEnabled: true },
    });
    if (config?.availabilityEnabled) {
      const { availableCount } = await checkRoomAvailability(hotelId, finalRoomTypeId, finalCheckIn, finalCheckOut);
      if (availableCount < 1) {
        throw new Error("Room is not available for the selected dates");
      }
    }
  }

  // ── Group booking: apply per-room updates then recompute total from children ──
  if (booking.rooms.length > 0 && rooms && rooms.length > 0) {
    const roomUpdatesById = new Map(rooms.map((r) => [r.id, r]));

    // Update each selected BookingRoom, recomputing its totalPrice with new nights
    for (const child of booking.rooms) {
      const upd = roomUpdatesById.get(child.id);
      if (!upd) continue;
      const newPrice    = upd.pricePerNight  ?? child.pricePerNight;
      const newRoomType = upd.roomTypeId     ?? child.roomTypeId;
      await prisma.bookingRoom.update({
        where: { id: child.id },
        data: {
          pricePerNight: newPrice,
          totalPrice:    newPrice * nights,
          roomTypeId:    newRoomType,
        },
      });
    }

    // Recompute grand total from all children (including untouched ones)
    const updatedChildren = await prisma.bookingRoom.findMany({ where: { bookingId: id } });
    const grandTotal = updatedChildren.reduce((s, r) => s + r.totalPrice, 0);

    // Primary roomTypeId on Booking = first child's type (keeps dashboard queries working)
    const firstChildRoomTypeId = updatedChildren[0]?.roomTypeId ?? finalRoomTypeId;

    return prisma.booking.update({
      where: { id },
      data: {
        ...(guestName ? { guestName } : {}),
        roomTypeId:    firstChildRoomTypeId,
        checkIn:       finalCheckIn,
        checkOut:      finalCheckOut,
        pricePerNight: updatedChildren[0]?.pricePerNight ?? booking.pricePerNight,
        totalPrice:    grandTotal,
        ...(advancePaid !== undefined ? { advancePaid } : {}),
      },
      include: {
        guest:    true,
        roomType: true,
        rooms:    { include: { roomType: { select: { name: true } } } },
      },
    });
  }

  // ── Single-room booking: existing path unchanged ──
  const finalPrice = pricePerNight ?? booking.pricePerNight;
  const totalPrice = nights * finalPrice;

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
    include: {
      guest:    true,
      roomType: true,
      rooms:    { include: { roomType: { select: { name: true } } } },
    },
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
