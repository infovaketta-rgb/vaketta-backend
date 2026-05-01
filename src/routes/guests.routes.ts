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

export default router;
