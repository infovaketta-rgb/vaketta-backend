import { Request, Response } from "express";
import { createBookingService, updateBookingService } from "../services/booking.service";
import prisma from "../db/connect";
import { BookingStatus } from "@prisma/client";

export async function createBooking(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;

    const {
      guestId,
      guestName,
      roomTypeId,
      checkIn,
      checkOut,
      pricePerNight,
      advancePaid,
    } = req.body;

    if (!guestId || !guestName || !roomTypeId || !checkIn || !checkOut) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    const booking = await createBookingService({
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
  } catch (err: any) {
    console.error("❌ Create booking failed", err.message);
    res.status(500).json({ error: "Create booking failed" });
  }
}

export async function getBookings(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;

    const bookings = await prisma.booking.findMany({
      where: { hotelId },
      include: {
        guest: true,
        roomType: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json(bookings);
  } catch (err) {
    console.error("❌ Get bookings failed:", err);
    return res.status(500).json({ error: "Failed to fetch bookings" });
  }
}
export async function updateBookingStatus(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { bookingId } = req.params;
    const { status } = req.body;

    const validStatuses = Object.values(BookingStatus);
    if (!bookingId || !status) {
      return res.status(400).json({ error: "bookingId and status required" });
    }
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
    }

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, hotelId },
    });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const updated = await prisma.booking.update({
      where: { id: bookingId, hotelId },
      data: { status },
    });

    res.json(updated);
  } catch (err) {
    console.error("Update booking status failed:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
}

export async function editBooking(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { bookingId } = req.params;
    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    const { guestName, roomTypeId, checkIn, checkOut, pricePerNight, advancePaid } = req.body;

    const booking = await updateBookingService({
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
  } catch (err: any) {
    console.error("Edit booking failed:", err.message);
    res.status(400).json({ error: err.message || "Failed to edit booking" });
  }
}

export async function getBookingSummary(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;

    const bookings = await prisma.booking.findMany({
      where: { hotelId, status: BookingStatus.CONFIRMED },
    });

    const totalRevenue = bookings.reduce(
      (sum, b) => sum + b.totalPrice,
      0
    );

    return res.json({
      totalBookings: bookings.length,
      totalRevenue,
    });
  } catch (err) {
    console.error("❌ Summary failed:", err);
    return res.status(500).json({ error: "Failed to fetch summary" });
  }
}
