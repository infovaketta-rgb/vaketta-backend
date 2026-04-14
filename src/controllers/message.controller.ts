import { Request, Response } from "express";
import path from "path";
import fs from "fs/promises";
import { sendManualReply } from "../services/message.service";
import prisma from "../db/connect";
import { MessageStatus } from "@prisma/client";
import { emitToHotel } from "../realtime/emit";
import { whatsappQueue } from "../queue/whatsapp.queue";
import { deleteFromR2 } from "../services/r2.service";

export async function manualReply(req: Request, res: Response) {
  try {
    const { guestId, text } = req.body;
    const hotelId = (req as any).user.hotelId;

    if (!guestId || !text) {
      return res.status(400).json({ error: "guestId and text are required" });
    }

    // Scope lookup to this hotel — prevents cross-tenant guest access
    const guest = await prisma.guest.findFirst({
      where: { id: guestId, hotelId },
      include: { hotel: true },
    });

    if (!guest) {
      return res.status(404).json({ error: "Guest not found" });
    }

    const message = await sendManualReply({
      hotelId,
      guestId,
      fromPhone: guest.hotel.phone,
      toPhone: guest.phone,
      text,
    });

    res.json(message);
  } catch (err: any) {
    console.error("❌ manualReply failed:", err);
    res.status(500).json({ error: err?.message ?? "Send failed" });
  }
}



export async function getMessages(req: Request, res: Response) {
  try{
    const guestId = req.params.guestId;

  if (!guestId) {
    return res.status(400).json({ error: "guestId required" });
  }
  
  const hotelId = (req as any).user.hotelId;

  const messages = await prisma.message.findMany({
    where: { 
      guestId,
      hotelId,  // 🔒 isolation enforced
    },
    orderBy: { timestamp: "asc" },
  });

  return res.json(messages);
} catch (err) {
    console.error("❌ Get messages failed:", err);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
}

/*** POST /messages/:guestId/read*/

export async function markMessagesRead(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { guestId } = req.params;
    

    if (!guestId) {
      return res.status(400).json({ error: "guestId required" });
    }

    // Mark unread incoming messages as READ
    await prisma.message.updateMany({
      where: {
        guestId,
        hotelId,
        direction: "IN",
        status: MessageStatus.RECEIVED,
      },
      data: { status: MessageStatus.READ },
    });

    // 🔥 EMIT REALTIME EVENT
    emitToHotel(hotelId, "message:read", { guestId });

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Mark read failed:", err);
    return res.status(500).json({ error: "Failed to mark read" });
  }
}

/** PATCH /messages/:guestId/bot — toggle bot on/off for a guest */
export async function setBotEnabled(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const guestId = req.params["guestId"];
    const { enabled } = req.body;

    if (!guestId) return res.status(400).json({ error: "guestId required" });
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled (boolean) is required" });
    }

    const guest = await prisma.guest.findFirst({ where: { id: guestId, hotelId } });
    if (!guest) return res.status(404).json({ error: "Guest not found" });

    await prisma.guest.update({
      where: { id: guest.id },
      data: { lastHandledByStaff: !enabled },
    });

    return res.json({ success: true, botEnabled: enabled });
  } catch (err) {
    console.error("❌ setBotEnabled failed:", err);
    return res.status(500).json({ error: "Failed to update bot status" });
  }
}

/** DELETE /messages/:messageId?everyone=true — delete from DB (+ WhatsApp if everyone=true) */
export async function deleteMessage(req: Request, res: Response) {
  try {
    const hotelId   = (req as any).user.hotelId as string;
    const messageId = req.params["messageId"] as string;
    const everyone  = req.query["everyone"] === "true";

    const msg = await prisma.message.findFirst({
      where: { id: messageId, hotelId },
      include: { hotel: { include: { config: true } } },
    });
    if (!msg) return res.status(404).json({ error: "Message not found" });

    // ── Unsend on WhatsApp (Delete for everyone) ───────────────────────────
    // Only possible for outgoing messages that have a wamid
    let whatsappDeleted = false;
    if (everyone && msg.direction === "OUT" && msg.wamid) {
      const accessToken     = (msg as any).hotel?.config?.metaAccessToken ?? "";
      const phoneNumberId   = (msg as any).hotel?.config?.metaPhoneNumberId ?? "";

      if (accessToken && phoneNumberId) {
        try {
          const waRes = await fetch(
            `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({
                messaging_product: "whatsapp",
                status: "deleted",
                message_id: msg.wamid,
              }),
              signal: AbortSignal.timeout(10_000),
            }
          );
          if (waRes.ok) {
            whatsappDeleted = true;
          } else {
            const waErr = await waRes.json().catch(() => ({}));
            console.warn("⚠️  WhatsApp unsend failed:", waErr);
          }
        } catch (waErr) {
          console.warn("⚠️  WhatsApp unsend error (non-fatal):", waErr);
        }
      }
    }

    // ── Delete media file ──────────────────────────────────────────────────
    if (msg.mediaUrl) {
      const publicR2 = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");
      if (publicR2 && msg.mediaUrl.startsWith(publicR2)) {
        const key = msg.mediaUrl.slice(publicR2.length + 1);
        await deleteFromR2(key);
      } else if (msg.mediaUrl.startsWith("/uploads/")) {
        const filePath = path.join(process.cwd(), msg.mediaUrl);
        await fs.unlink(filePath).catch(() => {});
      }
    }

    // ── Delete DB record ───────────────────────────────────────────────────
    await prisma.message.delete({ where: { id: messageId } });

    // Notify all dashboard clients
    emitToHotel(hotelId, "message:deleted", { messageId, guestId: msg.guestId });

    return res.json({ success: true, whatsappDeleted });
  } catch (err: any) {
    console.error("❌ deleteMessage:", err);
    return res.status(500).json({ error: "Failed to delete message" });
  }
}

/** POST /messages/send-media — staff sends a media file to a guest */
export async function sendMedia(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const file    = (req as any).file as { mimetype: string; filename: string; originalname: string } | undefined;

    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const { guestId, caption } = req.body;
    if (!guestId) return res.status(400).json({ error: "guestId is required" });

    const guest = await prisma.guest.findFirst({
      where: { id: guestId, hotelId },
      include: { hotel: true },
    });
    if (!guest) return res.status(404).json({ error: "Guest not found" });

    const mime = file.mimetype;
    const messageType = mime.startsWith("image/")  ? "image"
                      : mime.startsWith("video/")  ? "video"
                      : mime.startsWith("audio/")  ? "audio"
                      : "document";

    const mediaUrl = `/uploads/${file.filename}`;

    // Mark as staff-handled and reset bot session
    await prisma.guest.update({ where: { id: guest.id }, data: { lastHandledByStaff: true } });

    const message = await prisma.message.create({
      data: {
        direction:   "OUT",
        fromPhone:   guest.hotel.phone,
        toPhone:     guest.phone,
        body:        caption ?? null,
        messageType,
        mediaUrl,
        mimeType:    mime,
        fileName:    file.originalname,
        hotelId,
        guestId:     guest.id,
        status:      MessageStatus.PENDING,
      },
    });

    emitToHotel(hotelId, "message:new", { message });
    await whatsappQueue.add("send", { messageId: message.id });

    return res.json(message);
  } catch (err) {
    console.error("❌ sendMedia failed:", err);
    return res.status(500).json({ error: "Failed to send media" });
  }
}