import { Router, Request, Response } from "express";
import prisma from "../db/connect";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const page    = Math.max(1, parseInt(String(req.query.page  ?? "1"), 10));
    const limit   = 20;
    const skip    = (page - 1) * limit;
    const search  = String(req.query.search ?? "").trim();
    const channel = String(req.query.channel ?? "").toUpperCase();

    const where: any = { hotelId };
    if (search) {
      where.OR = [
        { name:  { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
      ];
    }

    const [guests, total] = await Promise.all([
      prisma.guest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id:                 true,
          name:               true,
          phone:              true,
          isVip:              true,
          tags:               true,
          createdAt:          true,
          lastHandledByStaff: true,
          _count: {
            select: { messages: true, bookings: true },
          },
          messages: {
            orderBy: { timestamp: "desc" },
            take: 1,
            select: { channel: true, timestamp: true },
          },
        },
      }),
      prisma.guest.count({ where }),
    ]);

    let rows = guests.map((g) => ({
      id:                 g.id,
      name:               g.name,
      phone:              g.phone,
      isVip:              g.isVip,
      tags:               g.tags,
      createdAt:          g.createdAt,
      lastHandledByStaff: g.lastHandledByStaff,
      totalMessages:      g._count.messages,
      bookingsCount:      g._count.bookings,
      channel:            g.messages[0]?.channel ?? "WHATSAPP",
      lastActivity:       g.messages[0]?.timestamp ?? g.createdAt,
    }));

    if (channel === "WHATSAPP" || channel === "INSTAGRAM") {
      rows = rows.filter((r) => r.channel === channel);
    }

    res.json({
      data:  rows,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /guests/:id ───────────────────────────────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const id      = req.params["id"];
    if (!id) return res.status(400).json({ error: "id required" });

    const guest = await prisma.guest.findFirst({
      where: { id, hotelId },
      include: {
        _count: { select: { messages: true } },
        bookings: {
          orderBy: { createdAt: "desc" },
          include: { roomType: { select: { name: true } } },
        },
        messages: {
          orderBy: { timestamp: "desc" },
          take: 50,
        },
      },
    });

    if (!guest) return res.status(404).json({ error: "Guest not found" });

    // Media messages — separate query (no take limit)
    const mediaMessages = await prisma.message.findMany({
      where:   { guestId: id, hotelId, mediaUrl: { not: null } },
      orderBy: { timestamp: "desc" },
      select:  { id: true, mediaUrl: true, mimeType: true, fileName: true, timestamp: true, direction: true },
    });

    const totalSpend = guest.bookings
      .filter((b) => b.status === "CONFIRMED")
      .reduce((sum, b) => sum + b.totalPrice, 0);

    // Synthesise activity log from bookings + latest message
    const activityLog: Array<{ type: string; timestamp: string; label: string }> = [];
    for (const b of guest.bookings) {
      activityLog.push({
        type:      "booking",
        timestamp: b.createdAt.toISOString(),
        label:     `Booking ${b.referenceNumber ?? b.id.slice(0, 8)} — ${b.status}`,
      });
    }
    if (guest.messages.length > 0) {
      const last = guest.messages[0];
      activityLog.push({
        type:      "message",
        timestamp: last.timestamp.toISOString(),
        label:     last.direction === "IN" ? "Sent a message" : "Received a reply",
      });
    }
    activityLog.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const lastActivity = guest.messages[0]?.timestamp ?? guest.createdAt;

    res.json({
      id:                 guest.id,
      name:               guest.name,
      phone:              guest.phone,
      notes:              guest.notes,
      isVip:              guest.isVip,
      tags:               guest.tags,
      createdAt:          guest.createdAt,
      lastHandledByStaff: guest.lastHandledByStaff,
      totalMessages:      guest._count.messages,
      totalSpend,
      lastActivity,
      channel:            guest.messages[0]?.channel ?? "WHATSAPP",
      bookings: guest.bookings.map((b) => ({
        id:              b.id,
        referenceNumber: b.referenceNumber,
        checkIn:         b.checkIn,
        checkOut:        b.checkOut,
        status:          b.status,
        totalPrice:      b.totalPrice,
        createdAt:       b.createdAt,
        roomType:        b.roomType ? { name: b.roomType.name } : null,
      })),
      recentMessages: guest.messages.map((m) => ({
        id:          m.id,
        body:        m.body,
        direction:   m.direction,
        channel:     m.channel,
        messageType: m.messageType,
        timestamp:   m.timestamp,
        mediaUrl:    m.mediaUrl,
        mimeType:    m.mimeType,
        fileName:    m.fileName,
        status:      m.status,
      })),
      mediaMessages,
      activityLog,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /guests/:id ─────────────────────────────────────────────────────────

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const id      = req.params["id"];
    if (!id) return res.status(400).json({ error: "id required" });

    const { name, notes, isVip, tags } = req.body as {
      name?:  string | null;
      notes?: string | null;
      isVip?: boolean;
      tags?:  string[];
    };

    const existing = await prisma.guest.findFirst({ where: { id, hotelId } });
    if (!existing) return res.status(404).json({ error: "Guest not found" });

    const patch: Record<string, unknown> = {};
    if (name  !== undefined) patch.name  = name  ?? null;
    if (notes !== undefined) patch.notes = notes ?? null;
    if (isVip !== undefined) patch.isVip = isVip;
    if (tags  !== undefined) patch.tags  = tags;

    const updated = await prisma.guest.update({
      where:  { id: id as string },
      data:   patch,
      select: { id: true, name: true, notes: true, isVip: true, tags: true },
    });

    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
