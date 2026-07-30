import { Request, Response } from "express";
import prisma from "../db/connect";
import { MessageStatus } from "@prisma/client";
import { enqueueInstagramProfileRefresh, profileEnrichmentEnabled } from "../services/instagram.profile.service";
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
        // Instagram profile enrichment (null for WhatsApp guests / pre-enrichment)
        igName: guest.igName ?? null,
        igUsername: guest.igUsername ?? null,
        igProfilePicUrl: guest.igProfilePicUrl ?? null,
        igFollowerCount: guest.igFollowerCount ?? null,
        igFollowsBusiness: guest.igFollowsBusiness ?? null,
        igBusinessFollows: guest.igBusinessFollows ?? null,
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

// ── GET /conversations/:guestId ───────────────────────────────────────────────
// Guest metadata for the chat header. ChatWindow can be deep-linked, so it
// can't rely on the list endpoint having loaded. Channel is derived from the
// most recent message, same pattern as the list.
export async function getConversation(req: Request, res: Response) {
  try {
    const user = (req as Request & { user?: JwtUser }).user;
    const hotelId = user?.hotelId;
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });

    const { guestId } = req.params as { guestId: string };

    const guest = await prisma.guest.findFirst({
      where: { id: guestId, hotelId },
      include: {
        messages: {
          orderBy: { timestamp: "desc" },
          take: 1,
          select: { channel: true },
        },
      },
    });
    if (!guest) return res.status(404).json({ error: "Guest not found" });

    return res.json({
      guestId: guest.id,
      phone: guest.phone,
      name: guest.name ?? null,
      channel: guest.messages[0]?.channel ?? "WHATSAPP",
      igName: guest.igName ?? null,
      igUsername: guest.igUsername ?? null,
      igProfilePicUrl: guest.igProfilePicUrl ?? null,
      igFollowerCount: guest.igFollowerCount ?? null,
      igFollowsBusiness: guest.igFollowsBusiness ?? null,
      igBusinessFollows: guest.igBusinessFollows ?? null,
    });
  } catch (err) {
    log.error({ err }, "get conversation failed");
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

// ── POST /conversations/:guestId/refresh-profile ──────────────────────────────
// Staff-triggered Instagram profile re-enqueue that bypasses the worker's TTL
// check. 202 = accepted; enrichment lands asynchronously via the worker.
export async function refreshGuestProfile(req: Request, res: Response) {
  try {
    const user = (req as Request & { user?: JwtUser }).user;
    const hotelId = user?.hotelId;
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });

    const { guestId } = req.params as { guestId: string };

    const guest = await prisma.guest.findFirst({
      where: { id: guestId, hotelId },
      include: {
        messages: {
          orderBy: { timestamp: "desc" },
          take: 1,
          select: { channel: true },
        },
      },
    });
    if (!guest) return res.status(404).json({ error: "Guest not found" });

    if ((guest.messages[0]?.channel ?? "WHATSAPP") !== "INSTAGRAM") {
      return res.status(400).json({ error: "Profile refresh is only available for Instagram conversations" });
    }
    if (!profileEnrichmentEnabled()) {
      return res.status(503).json({ error: "Instagram profile enrichment is disabled" });
    }

    // For Instagram guests, Guest.phone stores the account-scoped IGSID.
    await enqueueInstagramProfileRefresh({ hotelId, guestId: guest.id, igsid: guest.phone });

    return res.status(202).json({ accepted: true });
  } catch (err) {
    log.error({ err }, "refresh guest profile failed");
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
