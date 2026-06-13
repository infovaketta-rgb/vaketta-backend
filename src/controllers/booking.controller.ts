import { Request, Response } from "express";
import { createBookingService, updateBookingService } from "../services/booking.service";
import prisma from "../db/connect";
import { BookingStatus, MessageChannel } from "@prisma/client";
import { logger } from "../utils/logger";
import { emitToHotel } from "../realtime/emit";
import { sendTemplateMessage } from "../services/templates.service";
import { sendChannelMessage } from "../services/channel.send.service";
import { interpolate } from "../automation/interpolate";

const log = logger.child({ service: "booking" });

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

    const guestOwned = await prisma.guest.findFirst({ where: { id: guestId, hotelId } });
    if (!guestOwned) {
      return res.status(404).json({ error: "Guest not found" });
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
    log.error({ err: err.message }, "create booking failed");
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
    log.error({ err }, "get bookings failed");
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

    emitToHotel(hotelId, "booking:updated", { bookingId, status });
    return res.json({ success: true });
  } catch (err) {
    log.error({ err }, "update booking status failed");
    res.status(500).json({ error: "Failed to update status" });
  }
}

export async function editBooking(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { bookingId } = req.params;
    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    const { guestName, roomTypeId, checkIn, checkOut, pricePerNight, advancePaid, rooms } = req.body;

    // Serialize concurrent edits on the same booking to prevent lost updates.
    let booking: Awaited<ReturnType<typeof updateBookingService>>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${bookingId}))`;
      booking = await updateBookingService({
        id: bookingId,
        hotelId,
        guestName,
        roomTypeId,
        checkIn,
        checkOut,
        ...(pricePerNight !== undefined ? { pricePerNight: Number(pricePerNight) } : {}),
        ...(advancePaid   !== undefined ? { advancePaid:   Number(advancePaid)   } : {}),
        ...(Array.isArray(rooms)        ? { rooms }                               : {}),
      });
    });

    res.json(booking!);
    emitToHotel(hotelId, "booking:updated", { booking: booking! });
  } catch (err: any) {
    log.error({ err: err.message }, "edit booking failed");
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
      include: {
        guest:    true,
        roomType: true,
        rooms:    { include: { roomType: { select: { name: true } } } },
      },
    });

    if (!booking) return res.status(404).json({ error: "Booking not found" });
    return res.json(booking);
  } catch (err) {
    log.error({ err }, "get booking by id failed");
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
    if (ids.length > 500) {
      return res.status(400).json({ error: "Maximum 500 booking IDs per request" });
    }
    const validStatuses = Object.values(BookingStatus);
    if (!status || !validStatuses.includes(status as BookingStatus)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
    }

    const result = await prisma.booking.updateMany({
      where: { id: { in: ids }, hotelId },
      data:  { status: status as BookingStatus },
    });

    for (const bookingId of ids) {
      emitToHotel(hotelId, "booking:updated", { bookingId, status });
    }

    return res.json({ updated: result.count });
  } catch (err) {
    log.error({ err }, "bulk booking status update failed");
    return res.status(500).json({ error: "Failed to update bookings" });
  }
}

// ── Helpers for confirm-with-message ─────────────────────────────────────────

function formatDateShort(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function getGuestChannel(guestId: string, hotelId: string): Promise<MessageChannel> {
  const latest = await prisma.message.findFirst({
    where:   { guestId, hotelId },
    orderBy: { timestamp: "desc" },
    select:  { channel: true },
  });
  return latest?.channel ?? MessageChannel.WHATSAPP;
}

function buildVars(booking: any): Record<string, string> {
  const roomName =
    booking.rooms?.length > 0
      ? `${booking.rooms.length} room${booking.rooms.length !== 1 ? "s" : ""}`
      : (booking.roomType?.name ?? "");
  return {
    guestName:  booking.guestName || booking.guest?.name || "",
    bookingRef: booking.referenceNumber || booking.id,
    checkIn:    formatDateShort(new Date(booking.checkIn)),
    checkOut:   formatDateShort(new Date(booking.checkOut)),
    roomType:   roomName,
  };
}

async function resolveMessagePreview(
  hotelId: string,
  channel: MessageChannel,
  vars: Record<string, string>
): Promise<{ preview: string; templateId?: string; savedReplyId?: string }> {
  if (channel === MessageChannel.WHATSAPP) {
    // Find first APPROVED template whose name contains "booking" or "confirm"
    const template = await prisma.whatsAppTemplate.findFirst({
      where: {
        hotelId,
        status: "APPROVED",
        OR: [
          { name: { contains: "booking",  mode: "insensitive" } },
          { name: { contains: "confirm",  mode: "insensitive" } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    if (template) {
      const comps = template.components as any;
      const bodyText = comps?.body?.text ?? template.name;
      const preview = bodyText.replace(
        /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
        (_: string, k: string) => vars[k] ?? `{{${k}}}`
      );
      return { preview, templateId: template.id };
    }
    return { preview: `Dear ${vars.guestName}, your booking ${vars.bookingRef} has been confirmed. Check-in: ${vars.checkIn}, Check-out: ${vars.checkOut}. Room: ${vars.roomType}.` };
  }

  // Instagram — use a SavedReply
  const savedReply = await prisma.savedReply.findFirst({
    where: {
      hotelId,
      OR: [
        { category: { contains: "booking",  mode: "insensitive" } },
        { category: { contains: "confirm",  mode: "insensitive" } },
        { name:     { contains: "booking",  mode: "insensitive" } },
        { name:     { contains: "confirm",  mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  if (savedReply) {
    return { preview: interpolate(savedReply.body, vars), savedReplyId: savedReply.id };
  }
  // Fallback: first saved reply for this hotel
  const first = await prisma.savedReply.findFirst({ where: { hotelId }, orderBy: { createdAt: "asc" } });
  if (first) {
    return { preview: interpolate(first.body, vars), savedReplyId: first.id };
  }
  return { preview: `Dear ${vars.guestName}, your booking ${vars.bookingRef} has been confirmed. Check-in: ${vars.checkIn}, Check-out: ${vars.checkOut}.` };
}

// ── GET /bookings/:id/confirm-preview ─────────────────────────────────────────

export async function confirmBookingPreview(req: Request, res: Response) {
  try {
    const hotelId     = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    const booking = await prisma.booking.findFirst({
      where:   { id: bookingId, hotelId },
      include: { guest: true, roomType: true, rooms: { include: { roomType: { select: { name: true } } } } },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const channel = await getGuestChannel(booking.guestId, hotelId);
    const vars    = buildVars(booking);
    const { preview, templateId, savedReplyId } = await resolveMessagePreview(hotelId, channel, vars);

    return res.json({ channel, messagePreview: preview, templateId, savedReplyId });
  } catch (err) {
    log.error({ err }, "confirm-preview failed");
    return res.status(500).json({ error: "Failed to generate preview" });
  }
}

// ── POST /bookings/:id/confirm ────────────────────────────────────────────────

export async function confirmBooking(req: Request, res: Response) {
  try {
    const hotelId     = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    const { sendMessage } = req.body as { sendMessage?: boolean };

    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    const booking = await prisma.booking.findFirst({
      where:   { id: bookingId, hotelId },
      include: { guest: true, roomType: true, rooms: { include: { roomType: { select: { name: true } } } } },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const result = await prisma.booking.updateMany({
      where: { id: bookingId, hotelId },
      data:  { status: BookingStatus.CONFIRMED },
    });
    if (result.count === 0) return res.status(404).json({ error: "Booking not found or unauthorized" });

    emitToHotel(hotelId, "booking:updated", { bookingId, status: BookingStatus.CONFIRMED });

    if (sendMessage) {
      // Fire-and-forget — don't let send failure block the confirm response
      (async () => {
        try {
          const channel = await getGuestChannel(booking.guestId, hotelId);
          const vars    = buildVars(booking);
          const { templateId, savedReplyId, preview } = await resolveMessagePreview(hotelId, channel, vars);

          if (channel === MessageChannel.WHATSAPP && templateId) {
            await sendTemplateMessage(hotelId, booking.guestId, templateId, vars);
          } else {
            // Instagram or WhatsApp with no template — send plain text via channel router
            const hotel = await prisma.hotel.findUnique({ where: { id: hotelId }, select: { phone: true } });
            await sendChannelMessage({
              channel,
              toPhone:   booking.guest!.phone,
              fromPhone: hotel?.phone ?? "",
              hotelId,
              guestId:   booking.guestId,
              text:      preview,
            });
          }
        } catch (sendErr) {
          log.warn({ err: sendErr, bookingId }, "confirm-send failed (non-fatal)");
        }
      })();
    }

    return res.json({ success: true });
  } catch (err) {
    log.error({ err }, "confirm booking failed");
    return res.status(500).json({ error: "Failed to confirm booking" });
  }
}

export async function exportBookingsCsv(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { from, to } = req.query as { from?: string; to?: string };

    const fromDate = from ? new Date(from) : undefined;
    const toDate   = to   ? new Date(to)   : undefined;
    if (fromDate && isNaN(fromDate.getTime())) {
      return res.status(400).json({ error: "Invalid from date" });
    }
    if (toDate && isNaN(toDate.getTime())) {
      return res.status(400).json({ error: "Invalid to date" });
    }

    const where: any = { hotelId };
    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) where.createdAt.gte = fromDate;
      if (toDate)   where.createdAt.lte = toDate;
    }

    const bookings = await prisma.booking.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take:    10_000,
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
    log.error({ err }, "bookings CSV export failed");
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
    log.error({ err }, "booking summary failed");
    return res.status(500).json({ error: "Failed to fetch summary" });
  }
}
