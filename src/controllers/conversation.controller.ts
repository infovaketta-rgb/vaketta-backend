import { Request, Response } from "express";
import prisma from "../db/connect";
import { MessageStatus } from "@prisma/client";
import { logger } from "../utils/logger";

const log = logger.child({ service: "conversation" });

type JwtUser = { id: string; role: string; hotelId: string };

export async function getConversations(req: Request, res: Response) {
  try {
    const user = (req as Request & { user?: JwtUser }).user;
    const hotelId = user?.hotelId;

    if (!hotelId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const guests = await prisma.guest.findMany({
      where: { hotelId },
      include: {
        messages: {
          orderBy: { timestamp: "desc" },
          take: 1,
          select: {
            body: true,
            messageType: true,
            direction: true,
            timestamp: true,
            channel: true,
          },
        },
        _count: {
          select: {
            messages: {
              where: {
                direction: "IN",
                status: MessageStatus.RECEIVED,
              },
            },
          },
        },
      },
    });

    const result = guests.map((guest) => {
      const lastMessage = guest.messages[0];
      return {
        guestId: guest.id,
        phone: guest.phone,
        name: guest.name ?? null,
        lastHandledByStaff: guest.lastHandledByStaff,
        lastMessage: lastMessage?.body ?? null,
        lastMessageType: lastMessage?.messageType ?? null,
        lastDirection: lastMessage?.direction ?? null,
        lastTimestamp: lastMessage?.timestamp ?? null,
        channel: lastMessage?.channel ?? "WHATSAPP",
        unreadCount: guest._count.messages,
      };
    });

    // ✅ Sort by latest message timestamp — newest first
    result.sort((a, b) => {
      if (!a.lastTimestamp) return 1;
      if (!b.lastTimestamp) return -1;
      return new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime();
    });


    return res.json(result);
  } catch (err) {
    log.error({ err }, "get conversations failed");
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function updateGuestName(req: Request, res: Response) {
  try {
    const user    = (req as Request & { user?: JwtUser }).user;
    const hotelId = user?.hotelId;
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });

    const { guestId } = req.params as { guestId: string };
    const { name }    = req.body as { name?: string };

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    const guest = await prisma.guest.updateMany({
      where: { id: guestId, hotelId },
      data:  { name: name.trim() },
    });

    if (guest.count === 0) return res.status(404).json({ error: "Guest not found" });

    return res.json({ success: true, name: name.trim() });
  } catch (err) {
    log.error({ err }, "update guest name failed");
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
