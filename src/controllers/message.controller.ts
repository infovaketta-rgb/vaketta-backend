import { Request, Response } from "express";
import { sendManualReply, cancelPendingSend } from "../services/message.service";
import prisma from "../db/connect";
import { MessageStatus, MessageChannel } from "@prisma/client";
import { logger } from "../utils/logger";
import { redis } from "../queue/redis";

const log = logger.child({ service: "message" });
import { emitToHotel } from "../realtime/emit";
import { uploadToR2, deleteFromR2 } from "../services/r2.service";
import { sendMediaMessage } from "../services/whatsapp.send.service";
import { getMediaLimit, formatBytes } from "../utils/mediaLimits";
import { transcodeWebmToOgg } from "../utils/transcode";

export async function manualReply(req: Request, res: Response) {
  try {
    const { guestId, text } = req.body;
    const hotelId = (req as any).user.hotelId;

    if (!guestId || !text) {
      return res.status(400).json({ error: "guestId and text are required" });
    }
    if (typeof text !== "string" || text.length > 4096) {
      return res.status(400).json({ error: "text must be 1–4096 characters" });
    }

    // Rate limit: max 100 manual replies per minute per guest per hotel
    const rlKey   = `ratelimit:manualreply:${hotelId}:${guestId}`;
    const rlCount = await redis.incr(rlKey);
    if (rlCount === 1) await redis.expire(rlKey, 60);
    if (rlCount > 100) {
      return res.status(429).json({ error: "Rate limit exceeded. Max 100 messages per minute per guest." });
    }

    // Scope lookup to this hotel — prevents cross-tenant guest access
    const guest = await prisma.guest.findFirst({
      where: { id: guestId, hotelId },
      include: { hotel: true },
    });

    if (!guest) {
      return res.status(404).json({ error: "Guest not found" });
    }

    // Derive the channel from the guest's most recent message so Instagram
    // replies go via Instagram, not WhatsApp.
    const lastMsg = await prisma.message.findFirst({
      where:   { guestId, hotelId },
      orderBy: { timestamp: "desc" },
      select:  { channel: true },
    });
    const channel = lastMsg?.channel ?? MessageChannel.WHATSAPP;

    const result = await sendManualReply({
      hotelId,
      guestId,
      fromPhone: guest.hotel.phone,
      toPhone:   guest.phone,
      text,
      channel,
    });

    // Return { message, delaySeconds } — frontend uses delaySeconds to show countdown
    res.json(result);
  } catch (err: any) {
    log.error({ err }, "manual reply failed");
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
    log.error({ err }, "get messages failed");
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
    log.error({ err }, "mark messages read failed");
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
    log.error({ err }, "set bot enabled failed");
    return res.status(500).json({ error: "Failed to update bot status" });
  }
}

/** DELETE /messages/:messageId — soft-delete: marks deleted in DB, keeps tombstone */
export async function deleteMessage(req: Request, res: Response) {
  try {
    const hotelId   = (req as any).user.hotelId as string;
    const userId    = (req as any).user.id     as string;
    const messageId = req.params["messageId"]  as string;

    const msg = await prisma.message.findFirst({
      where: { id: messageId, hotelId },
    });
    if (!msg) return res.status(404).json({ error: "Message not found" });
    if (msg.deleted) return res.status(400).json({ error: "Message already deleted" });

    // Look up the staff member's name for the tombstone
    const staff = await prisma.user.findUnique({
      where:  { id: userId },
      select: { name: true },
    });
    const deletedBy = staff?.name ?? "Staff";

    // ── Delete media from R2 before wiping the URL ───────────────────────────
    if (msg.mediaUrl) {
      // Extract the R2 object key from the public URL: strip base URL, keep "media/..."
      const publicBase = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
      const key = publicBase && msg.mediaUrl.startsWith(publicBase)
        ? msg.mediaUrl.slice(publicBase.length + 1)
        : msg.mediaUrl.startsWith("media/")
          ? msg.mediaUrl
          : null;
      if (key) {
        deleteFromR2(key).catch((err) =>
          log.error({ err, key }, "R2 delete failed")
        );
      }
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        deleted:   true,
        deletedBy,
        deletedAt: new Date(),
        // wipe content so media / text can't be reconstructed from DB
        body:      null,
        mediaUrl:  null,
        mimeType:  null,
        fileName:  null,
      },
    });

    // Push tombstone to all open dashboard tabs in real time
    emitToHotel(hotelId, "message:deleted", {
      messageId,
      guestId:   msg.guestId,
      deletedBy,
    });

    return res.json({ success: true, message: updated });
  } catch (err: any) {
    log.error({ err }, "delete message failed");
    return res.status(500).json({ error: "Failed to delete message" });
  }
}

/** DELETE /messages/:messageId/undo-send — cancel a pending delayed message before it sends */
export async function undoSend(req: Request, res: Response) {
  try {
    const hotelId   = (req as any).user.hotelId as string;
    const messageId = req.params["messageId"]   as string;

    // Read guestId before deleting (needed for the socket emit below).
    const msg = await prisma.message.findFirst({
      where:  { id: messageId, hotelId },
      select: { guestId: true, status: true },
    });
    if (!msg) return res.status(404).json({ error: "Message not found" });

    // Cancel the in-memory timer first (no-op if it already fired).
    cancelPendingSend(messageId);

    // Atomic guard: only delete while still PENDING. If the timer already
    // claimed the row (set status → SENT), deleteMany returns count=0 and
    // we surface a 409 instead of silently deleting a delivered message.
    const deleted = await prisma.message.deleteMany({
      where: { id: messageId, hotelId, status: MessageStatus.PENDING },
    });
    if (deleted.count === 0) {
      return res.status(409).json({ error: "Message has already been sent — cannot undo" });
    }

    // Notify all open dashboard tabs to remove the pending bubble
    emitToHotel(hotelId, "message:undo", { messageId, guestId: msg.guestId });

    return res.json({ success: true });
  } catch (err: any) {
    log.error({ err }, "undo send failed");
    return res.status(500).json({ error: "Failed to undo send" });
  }
}

/** POST /messages/send-media — staff sends a media file to a guest */
export async function sendMedia(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const file    = (req as any).file as {
      mimetype:     string;
      originalname: string;
      buffer:       Buffer;
    } | undefined;

    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const { guestId, caption } = req.body;
    if (!guestId) return res.status(400).json({ error: "guestId is required" });

    const guest = await prisma.guest.findFirst({
      where: { id: guestId, hotelId },
      include: { hotel: true },
    });
    if (!guest) return res.status(404).json({ error: "Guest not found" });

    // ── Pre-upload size check ───────────────────────────────────────────────
    const baseMime = file.mimetype.split(";")[0]!.trim();
    const sizeLimit = getMediaLimit(baseMime);
    if (file.buffer.length > sizeLimit) {
      return res.status(413).json({ error: `File too large: max ${formatBytes(sizeLimit)} for ${baseMime}` });
    }

    // ── Transcode WebM audio → OGG before upload ────────────────────────────
    // WhatsApp Cloud API accepts audio/ogg (Opus) but not audio/webm. Browsers record
    // as audio/webm. We transcode to an actual OGG/Opus container so R2 serves real
    // OGG bytes — not WebM bytes with a lying Content-Type header.
    let uploadBuffer   = file.buffer;
    let uploadMimeHint = file.mimetype;
    if (baseMime === "audio/webm") {
      uploadBuffer   = await transcodeWebmToOgg(file.buffer);
      uploadMimeHint = "audio/ogg";
    }

    // ── Upload to R2 ────────────────────────────────────────────────────────
    const uploaded       = await uploadToR2(uploadBuffer, uploadMimeHint, { hotelId });
    const mediaUrl       = uploaded.url;
    const storedFileName = uploaded.fileName;
    const mime           = uploaded.mime; // use detected MIME, not client claim

    const messageType = mime.startsWith("image/")  ? "image"
                      : mime.startsWith("video/")  ? "video"
                      : mime.startsWith("audio/")  ? "audio"
                      : "document";

    // After transcoding, mime is audio/ogg — already accepted by WhatsApp
    const whatsappMime = mime;

    // Mark as staff-handled
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
        fileName:    storedFileName,
        hotelId,
        guestId:     guest.id,
        status:      MessageStatus.PENDING,
      },
    });

    emitToHotel(hotelId, "message:new", { message });

    // Send directly — no queue, same pattern as text replies
    let wamid: string | undefined;
    let finalStatus: MessageStatus = MessageStatus.FAILED;
    try {
      const result = await sendMediaMessage({
        toPhone:     guest.phone,
        hotelId,
        messageType,
        mediaUrl,
        mimeType:    whatsappMime,  // Meta API only — DB stores original mime above
        fileName:    storedFileName,
        caption:     caption ?? null,
      });
      wamid = (result as any)?.messages?.[0]?.id ?? undefined;
      finalStatus = MessageStatus.SENT;
    } catch (err) {
      log.error({ err }, "send media message failed");
    }

    const updated = await prisma.message.update({
      where: { id: message.id },
      data:  { status: finalStatus, ...(wamid ? { wamid } : {}) },
    });

    emitToHotel(hotelId, "message:status", { messageId: message.id, status: finalStatus });

    return res.json(updated);
  } catch (err) {
    log.error({ err }, "send media failed");
    return res.status(500).json({ error: "Failed to send media" });
  }
}

/** POST /messages/send-media-url — resend an existing R2 media URL to a guest */
export async function sendMediaFromUrl(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { guestId, mediaUrl, mimeType, fileName, messageType } = req.body;

    if (!guestId || !mediaUrl) return res.status(400).json({ error: "guestId and mediaUrl required" });

    const r2Base = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
    if (!r2Base || !mediaUrl.startsWith(`${r2Base}/`)) {
      return res.status(400).json({ error: "mediaUrl must be hosted on the Vaketta CDN" });
    }

    const guest = await prisma.guest.findFirst({
      where: { id: guestId, hotelId },
      include: { hotel: true },
    });
    if (!guest) return res.status(404).json({ error: "Guest not found" });

    await prisma.guest.update({ where: { id: guest.id }, data: { lastHandledByStaff: true } });

    const message = await prisma.message.create({
      data: {
        direction:   "OUT",
        fromPhone:   guest.hotel.phone,
        toPhone:     guest.phone,
        body:        null,
        messageType: messageType ?? "image",
        mediaUrl,
        mimeType:    mimeType ?? null,
        fileName:    fileName ?? null,
        hotelId,
        guestId:     guest.id,
        status:      MessageStatus.PENDING,
      },
    });

    emitToHotel(hotelId, "message:new", { message });

    let wamid: string | undefined;
    let finalStatus: MessageStatus = MessageStatus.FAILED;
    try {
      const result = await sendMediaMessage({
        toPhone:     guest.phone,
        hotelId,
        messageType: messageType ?? "image",
        mediaUrl,
        mimeType:    mimeType ?? "image/jpeg",
        fileName:    fileName ?? null,
        caption:     null,
      });
      wamid = (result as any)?.messages?.[0]?.id ?? undefined;
      finalStatus = MessageStatus.SENT;
    } catch (err) {
      log.error({ err }, "send media from url WhatsApp send failed");
    }

    const updated = await prisma.message.update({
      where: { id: message.id },
      data:  { status: finalStatus, ...(wamid ? { wamid } : {}) },
    });

    emitToHotel(hotelId, "message:status", { messageId: message.id, status: finalStatus });
    return res.json(updated);
  } catch (err: any) {
    log.error({ err }, "send media from url failed");
    return res.status(500).json({ error: "Failed to send media" });
  }
}