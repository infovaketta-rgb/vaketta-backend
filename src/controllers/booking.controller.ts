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

    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip  = (page - 1) * limit;

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where: { hotelId },
        include: { guest: true, roomType: true },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.booking.count({ where: { hotelId } }),
    ]);

    return res.json({ data: bookings, total, page, pages: Math.ceil(total / limit) });
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

    const result = await prisma.booking.updateMany({
      where: { id: bookingId, hotelId },
      data: { status },
    });

    if (result.count === 0) {
      return res.status(404).json({ success: false, message: "Booking not found or unauthorized" });
    }

    return res.json({ success: true });
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

export async function getBookingById(req: Request, res: Response) {
  try {
    const hotelId   = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    const booking = await prisma.booking.findFirst({
      where:   { id: bookingId, hotelId },
      include: { guest: true, roomType: true },
    });

    if (!booking) return res.status(404).json({ error: "Booking not found" });
    return res.json(booking);
  } catch (err) {
    console.error("❌ getBookingById failed:", err);
    return res.status(500).json({ error: "Failed to fetch booking" });
  }
}

export async function bulkUpdateBookingStatus(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { ids, status } = req.body as { ids?: string[]; status?: string };

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }
    const validStatuses = Object.values(BookingStatus);
    if (!status || !validStatuses.includes(status as BookingStatus)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
    }

    const result = await prisma.booking.updateMany({
      where: { id: { in: ids }, hotelId },
      data:  { status: status as BookingStatus },
    });

    return res.json({ updated: result.count });
  } catch (err) {
    console.error("❌ Bulk status update failed:", err);
    return res.status(500).json({ error: "Failed to update bookings" });
  }
}

export async function exportBookingsCsv(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { from, to } = req.query as { from?: string; to?: string };

    const where: any = { hotelId };
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   where.createdAt.lte = new Date(to);
    }

    const bookings = await prisma.booking.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { roomType: { select: { name: true } } },
    });

    const escape = (v: unknown) => {
      const s = String(v ?? "").replace(/"/g, '""');
      return `"${s}"`;
    };

    const headers = ["Reference","Guest Name","Room Type","Check-In","Check-Out","Nights","Price/Night","Advance Paid","Total","Status","Created"];
    const rows = bookings.map((b) => {
      const nights = Math.ceil((new Date(b.checkOut).getTime() - new Date(b.checkIn).getTime()) / 86_400_000);
      return [
        b.referenceNumber ?? b.id,
        b.guestName,
        b.roomType.name,
        b.checkIn.toISOString().slice(0, 10),
        b.checkOut.toISOString().slice(0, 10),
        nights,
        b.pricePerNight,
        b.advancePaid,
        b.totalPrice,
        b.status,
        b.createdAt.toISOString().slice(0, 10),
      ].map(escape).join(",");
    });

    const csv = [headers.join(","), ...rows].join("\r\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="bookings-${Date.now()}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error("❌ CSV export failed:", err);
    return res.status(500).json({ error: "Failed to export bookings" });
  }
}

export async function getBookingSummary(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;

    const [count, agg] = await Promise.all([
      prisma.booking.count({ where: { hotelId, status: BookingStatus.CONFIRMED } }),
      prisma.booking.aggregate({
        where: { hotelId, status: BookingStatus.CONFIRMED },
        _sum:  { totalPrice: true },
      }),
    ]);

    return res.json({
      totalBookings: count,
      totalRevenue:  Number(agg._sum.totalPrice ?? 0),
    });
  } catch (err) {
    console.error("❌ Summary failed:", err);
    return res.status(500).json({ error: "Failed to fetch summary" });
  }
}
