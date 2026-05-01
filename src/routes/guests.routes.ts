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

    // Build the WHERE clause for the Guest table
    const where: any = { hotelId };
    if (search) {
      where.OR = [
        { name:  { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
      ];
    }

    // Channel filter is applied via message sub-query after fetch when needed
    // (Prisma doesn't support filtering by aggregated related field in WHERE directly)

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

    // Shape the response
    let rows = guests.map((g) => ({
      id:                 g.id,
      name:               g.name,
      phone:              g.phone,
      createdAt:          g.createdAt,
      lastHandledByStaff: g.lastHandledByStaff,
      totalMessages:      g._count.messages,
      bookingsCount:      g._count.bookings,
      channel:            g.messages[0]?.channel ?? "WHATSAPP",
      lastActivity:       g.messages[0]?.timestamp ?? g.createdAt,
    }));

    // Apply channel filter after aggregation
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
    const { id }  = req.params;

    const guest = await prisma.guest.findFirst({
      where: { id, hotelId },
      select: {
        id:                 true,
        name:               true,
        phone:              true,
        notes:              true,
        createdAt:          true,
        lastHandledByStaff: true,
        _count: { select: { messages: true } },
        bookings: {
          orderBy: { createdAt: "desc" },
          select: {
            id:              true,
            referenceNumber: true,
            checkIn:         true,
            checkOut:        true,
            status:          true,
            totalPrice:      true,
            createdAt:       true,
            roomType: { select: { name: true } },
          },
        },
        messages: {
          orderBy: { timestamp: "desc" },
          take: 10,
          select: {
            id:          true,
            body:        true,
            direction:   true,
            channel:     true,
            messageType: true,
            timestamp:   true,
          },
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

    const lastActivity = guest.messages[0]?.timestamp ?? guest.createdAt;

    res.json({
      id:                 guest.id,
      name:               guest.name,
      phone:              guest.phone,
      notes:              guest.notes,
      createdAt:          guest.createdAt,
      lastHandledByStaff: guest.lastHandledByStaff,
      totalMessages:      guest._count.messages,
      lastActivity,
      channel:            (guest.messages[0] as any)?.channel ?? "WHATSAPP",
      bookings:           guest.bookings,
      recentMessages:     guest.messages,
      mediaMessages,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /guests/:id ─────────────────────────────────────────────────────────

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const { id }  = req.params;
    const { name, notes } = req.body as { name?: string | null; notes?: string | null };

    const existing = await prisma.guest.findFirst({ where: { id, hotelId } });
    if (!existing) return res.status(404).json({ error: "Guest not found" });

    const patch: Record<string, unknown> = {};
    if (name  !== undefined) patch.name  = name  ?? null;
    if (notes !== undefined) patch.notes = notes ?? null;

    const updated = await prisma.guest.update({
      where: { id },
      data:  patch,
      select: { id: true, name: true, notes: true },
    });

    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
