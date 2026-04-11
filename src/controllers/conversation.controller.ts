import { Request, Response } from "express";
import prisma from "../db/connect";
import { MessageStatus } from "@prisma/client";

type JwtUser = { id: string; role: string; hotelId: string };

export async function getConversations(req: Request, res: Response) {
  try {
    const user = (req as Request & { user?: JwtUser }).user;
    const hotelId = user?.hotelId;

    if (!hotelId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const guests = await prisma.guest.findMany({
      where: {
        hotelId: hotelId,
      },
      include: {
        messages: {
          orderBy: { timestamp: "desc" },
          take: 1,
        },
      },
    });

    const result = await Promise.all(
      guests.map(async (guest) => {
        const lastMessage = guest.messages[0];

        const unreadCount = await prisma.message.count({
          where: {
            hotelId: hotelId,
            guestId: guest.id,
            direction: "IN",
            status: MessageStatus.RECEIVED,
          },
        });

        return {
          guestId: guest.id,
          phone: guest.phone,
          lastHandledByStaff: guest.lastHandledByStaff,
          lastMessage: lastMessage?.body ?? null,
          lastMessageType: lastMessage?.messageType ?? null,
          lastDirection: lastMessage?.direction ?? null,
          lastTimestamp: lastMessage?.timestamp ?? null,
          unreadCount,
        };
      })
    );

    // ✅ Sort by latest message timestamp — newest first
    result.sort((a, b) => {
      if (!a.lastTimestamp) return 1;
      if (!b.lastTimestamp) return -1;
      return new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime();
    });


    return res.json(result);
  } catch (err) {
    console.error("❌ Get conversations failed:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}