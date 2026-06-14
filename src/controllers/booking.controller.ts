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

// ── Shared helpers ────────────────────────────────────────────────────────────

function formatDateShort(d: Date): string {
  return d.toISOString().slice(0, 10);
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

function interpolateTemplateBody(bodyText: string, vars: Record<string, string>): string {
  return bodyText.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_: string, k: string) => vars[k] ?? `{{${k}}}`
  );
}

// Extract unique variable names from a template body ({{varName}} or {{1}} patterns).
function extractTemplateVars(components: any): string[] {
  const bodyText = components?.body?.text ?? "";
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  const seen = new Set<string>();
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyText)) !== null) {
    const name = m[1]!;
    if (!seen.has(name)) { seen.add(name); names.push(name); }
  }
  return names;
}

// ── GET /bookings/:id/confirm-options ─────────────────────────────────────────
//
// Returns available message options for the guest's channel:
//   WHATSAPP → { channel, options: [{ id, name, bodyPreview }] }  (APPROVED templates only)
//   INSTAGRAM → { channel, options: [{ id, name, bodyPreview }] } (all saved replies)

export async function confirmBookingOptions(req: Request, res: Response) {
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

    const hotelCfg = await prisma.hotelConfig.findUnique({
      where:  { hotelId },
      select: { botMessages: true },
    });
    const botMsgs = (hotelCfg?.botMessages ?? {}) as Record<string, string>;

    if (channel === MessageChannel.WHATSAPP) {
      const templates = await prisma.whatsAppTemplate.findMany({
        where:   { hotelId, status: "APPROVED" },
        orderBy: { name: "asc" },
        select:  { id: true, name: true, language: true, components: true },
      });
      const options = templates.map((t) => {
        const comps    = t.components as any;
        const bodyText = comps?.body?.text ?? t.name;
        const varNames = extractTemplateVars(comps);
        const variables = varNames.map((name) => ({ name, defaultValue: vars[name] ?? "" }));
        return {
          id:          t.id,
          name:        t.name,
          language:    t.language,
          bodyPreview: interpolateTemplateBody(bodyText, vars),
          variables,
        };
      });
      const defaultId = botMsgs.defaultConfirmTemplateId || null;
      return res.json({ channel, options, defaultId });
    }

    // Instagram
    const savedReplies = await prisma.savedReply.findMany({
      where:   { hotelId },
      orderBy: { name: "asc" },
      select:  { id: true, name: true, category: true, body: true },
    });
    const options = savedReplies.map((r) => ({
      id:          r.id,
      name:        r.name,
      category:    r.category ?? null,
      bodyPreview: interpolate(r.body, vars),
    }));
    const defaultId = botMsgs.defaultConfirmSavedReplyId || null;
    return res.json({ channel, options, defaultId });
  } catch (err) {
    log.error({ err }, "confirm-options failed");
    return res.status(500).json({ error: "Failed to load message options" });
  }
}

// ── GET /bookings/:id/confirm-preview?templateId=&savedReplyId= ───────────────
//
// Returns interpolated preview for a specific selection.
// If no id provided, returns the channel so the frontend can show options.

export async function confirmBookingPreview(req: Request, res: Response) {
  try {
    const hotelId     = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    const { templateId, savedReplyId } = req.query as { templateId?: string; savedReplyId?: string };

    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    const booking = await prisma.booking.findFirst({
      where:   { id: bookingId, hotelId },
      include: { guest: true, roomType: true, rooms: { include: { roomType: { select: { name: true } } } } },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const channel = await getGuestChannel(booking.guestId, hotelId);
    const vars    = buildVars(booking);

    if (templateId) {
      const template = await prisma.whatsAppTemplate.findFirst({
        where: { id: templateId, hotelId, status: "APPROVED" },
      });
      if (!template) return res.status(404).json({ error: "Template not found or not approved" });
      const comps    = template.components as any;
      const bodyText = comps?.body?.text ?? template.name;
      return res.json({ channel, messagePreview: interpolateTemplateBody(bodyText, vars), templateId });
    }

    if (savedReplyId) {
      const savedReply = await prisma.savedReply.findFirst({
        where: { id: savedReplyId, hotelId },
      });
      if (!savedReply) return res.status(404).json({ error: "Saved reply not found" });
      return res.json({ channel, messagePreview: interpolate(savedReply.body, vars), savedReplyId });
    }

    // No selection yet — return channel only so modal can drive the selection UI
    return res.json({ channel, messagePreview: null });
  } catch (err) {
    log.error({ err }, "confirm-preview failed");
    return res.status(500).json({ error: "Failed to generate preview" });
  }
}

// ── POST /bookings/:id/confirm ────────────────────────────────────────────────
//
// Body: { sendMessage: boolean, templateId?: string, savedReplyId?: string }
// Sets booking to CONFIRMED. If sendMessage=true, uses the explicitly provided
// templateId or savedReplyId — no hardcoded fallback lookup.

export async function confirmBooking(req: Request, res: Response) {
  try {
    const hotelId     = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    const { sendMessage, templateId, savedReplyId, variables } =
      req.body as { sendMessage?: boolean; templateId?: string; savedReplyId?: string; variables?: Record<string, string> };

    if (!bookingId) return res.status(400).json({ error: "bookingId required" });
    if (sendMessage && !templateId && !savedReplyId) {
      return res.status(400).json({ error: "templateId or savedReplyId required when sendMessage is true" });
    }
    if (sendMessage && templateId && variables) {
      const empty = Object.entries(variables).filter(([, v]) => !v.trim());
      if (empty.length > 0) {
        return res.status(400).json({
          error: `Template variable${empty.length > 1 ? "s" : ""} cannot be empty: ${empty.map(([k]) => k).join(", ")}`,
        });
      }
    }

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
      (async () => {
        try {
          const channel = await getGuestChannel(booking.guestId, hotelId);
          const vars    = buildVars(booking);

          if (templateId) {
            await sendTemplateMessage(hotelId, booking.guestId, templateId, variables ?? vars);
          } else if (savedReplyId) {
            const savedReply = await prisma.savedReply.findFirst({ where: { id: savedReplyId, hotelId } });
            if (!savedReply) throw new Error("Saved reply not found");
            const text  = interpolate(savedReply.body, vars);
            const hotel = await prisma.hotel.findUnique({ where: { id: hotelId }, select: { phone: true } });
            await sendChannelMessage({
              channel,
              toPhone:   booking.guest!.phone,
              fromPhone: hotel?.phone ?? "",
              hotelId,
              guestId:   booking.guestId,
              text,
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
