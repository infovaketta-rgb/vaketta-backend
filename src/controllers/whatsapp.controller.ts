import { Request, Response } from "express";
import { logIncomingMessage } from "../services/message.service";
import { normalizePhone } from "../utils/phone";
import prisma from "../db/connect";
import { MessageStatus } from "@prisma/client";
import { emitToHotel } from "../realtime/emit";
import { extractMediaFromWebhookMessage, downloadMetaMedia } from "../services/media.service";
import { processHistoryWebhook, processSmbMessageEcho } from "../services/history.service";
import crypto from "crypto";
import { logger } from "../utils/logger";

const log = logger.child({ service: "whatsapp" });

const META_STATUS_MAP: Record<string, MessageStatus> = {
  sent:      MessageStatus.SENT,
  delivered: MessageStatus.DELIVERED,
  read:      MessageStatus.READ,
  failed:    MessageStatus.FAILED,
};

const STATUS_RANK: Record<string, number> = {
  RECEIVED:  0,
  SENT:      1,
  DELIVERED: 2,
  READ:      3,
  FAILED:    4,
};

// Bug 1: GET handler for Meta webhook verification challenge
export function verifyWhatsAppWebhook(req: Request, res: Response) {
  const mode      = req.query["hub.mode"] as string | undefined;
  const token     = req.query["hub.verify_token"] as string | undefined;
  const challenge = req.query["hub.challenge"] as string | undefined;

  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN ?? "";

  const ha = crypto.createHash("sha256").update(token ?? "").digest();
  const hb = crypto.createHash("sha256").update(expectedToken).digest();
  const tokenMatch = crypto.timingSafeEqual(ha, hb);

  if (mode === "subscribe" && tokenMatch) {
    log.info("WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }

  log.warn({ mode }, "WhatsApp webhook verification failed");
  return res.sendStatus(403);
}

export async function handleWhatsAppWebhook(req: Request, res: Response) {
  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;

    // Handle Coexistence history sync chunks
    if (change?.field === "history") {
      processHistoryWebhook(change.value).catch((err) =>
        log.error({ err }, "history webhook processing failed")
      );
      return res.sendStatus(200);
    }

    // Handle echoes of messages the hotel sends from WhatsApp Business App
    if (change?.field === "smb_message_echoes") {
      processSmbMessageEcho(change.value).catch((err) =>
        log.error({ err }, "smb_message_echoes processing failed")
      );
      return res.sendStatus(200);
    }

    // Handle template status updates (APPROVED / REJECTED / PAUSED / DISABLED)
    if (change?.field === "message_template_status_update") {
      const { message_template_id, event, reason } = value ?? {};
      if (message_template_id && event) {
        await prisma.whatsAppTemplate.updateMany({
          where: { metaTemplateId: String(message_template_id) },
          data:  { status: event, rejectionReason: reason ?? null },
        });
      }
      return res.sendStatus(200);
    }

    // Handle Meta status updates (sent / delivered / read / failed)
    const statusUpdate = value?.statuses?.[0];
    if (statusUpdate) {
      const wamid      = statusUpdate.id as string | undefined;
      const metaStatus = statusUpdate.status as string | undefined;
      const newStatus  = metaStatus ? META_STATUS_MAP[metaStatus] : undefined;

      if (wamid && newStatus) {
        const updated = await prisma.message.findFirst({ where: { wamid } });
        if (updated) {
          const currentRank = STATUS_RANK[updated.status] ?? 0;
          const newRank     = STATUS_RANK[newStatus]       ?? 0;

          if (newRank > currentRank) {
            await prisma.message.update({
              where: { id: updated.id },
              data:  { status: newStatus },
            });
            emitToHotel(updated.hotelId, "message:status", {
              messageId: updated.id,
              status:    newStatus,
            });
          }
          // else: ignore out-of-order or duplicate webhook
        }
      }
      return res.sendStatus(200);
    }

    // Handle incoming guest messages
    const message = value?.messages?.[0];
    if (!message) {
      return res.sendStatus(200);
    }

    const rawFrom = message.from as string | undefined;
    const rawTo   = value?.metadata?.display_phone_number as string | undefined;

    if (!rawFrom || !rawTo) {
      log.warn({ rawFrom, rawTo }, "missing phone numbers in webhook payload");
      return res.sendStatus(200);
    }

    const fromPhone   = normalizePhone(rawFrom);
    const toPhone     = normalizePhone(rawTo);
    let   messageType = (message.type as string) || "text";
    const wamid       = (message.id as string | undefined) ?? null;

    // Extract text body (text messages) or caption (media messages)
    let body: string | null = message.text?.body ?? message[messageType]?.caption ?? null;

    // Interactive replies (e.g. carousel "Select Room" tap) — collapse to a
    // text message whose body is the reply id, so the flow engine can match
    // patterns like "room_<roomId>" without any new code path downstream.
    if (messageType === "interactive") {
      const ir = message.interactive;
      const replyId =
        ir?.type === "button_reply" ? (ir.button_reply?.id as string | undefined) :
        ir?.type === "list_reply"   ? (ir.list_reply?.id   as string | undefined) :
                                      undefined;
      if (!replyId) {
        log.info({ irType: ir?.type }, "skipping interactive reply with no id");
        return res.sendStatus(200);
      }
      messageType = "text";
      body        = replyId;
    }

    const SUPPORTED_TYPES = new Set(["text", "image", "video", "audio", "document", "sticker"]);

    if (!SUPPORTED_TYPES.has(messageType)) {
      log.info({ messageType }, "skipping unsupported message type");
      return res.sendStatus(200);
    }

    const mediaInfo = extractMediaFromWebhookMessage(message);

    if (mediaInfo) {
      // Save immediately with placeholder so the UI bubble appears at once
      await logIncomingMessage({
        fromPhone, toPhone, body, messageType,
        mediaUrl: `pending://${mediaInfo.mediaId}`,
        mimeType: mediaInfo.mimeType,
        fileName: mediaInfo.fileName,
        wamid,
      });

      // Upload to R2 in the background — never blocks the webhook ACK
      downloadAndStoreMedia(mediaInfo, toPhone).catch((err) =>
        log.error({ err }, "media background upload failed")
      );

      return res.sendStatus(200);
    }

    // Non-media message — existing flow unchanged
    await logIncomingMessage({ fromPhone, toPhone, body, messageType, mediaUrl: null, mimeType: null, fileName: null, wamid });

    return res.sendStatus(200);
  } catch (err) {
    log.error({ err }, "WhatsApp webhook error");
    return res.sendStatus(200); // always ACK to prevent Meta retries
  }
}

async function downloadAndStoreMedia(
  mediaInfo: { mediaId: string; mimeType: string; fileName: string | null },
  toPhone: string,
): Promise<void> {
  const hotel = await prisma.hotel.findUnique({
    where:   { phone: toPhone },
    include: { config: true },
  });
  if (!hotel) return;

  const message = await prisma.message.findFirst({
    where:   { mediaUrl: `pending://${mediaInfo.mediaId}`, hotelId: hotel.id },
    orderBy: { timestamp: "desc" },
  });
  if (!message) return;

  const downloaded = await downloadMetaMedia(mediaInfo.mediaId, mediaInfo.mimeType, toPhone);
  if (!downloaded) return;

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: {
      mediaUrl: downloaded.localUrl,
      mimeType: downloaded.mimeType,
      fileName: downloaded.fileName,
    },
  });

  emitToHotel(hotel.id, "message:media_ready", {
    messageId: updated.id,
    mediaUrl:  downloaded.localUrl,
    mimeType:  downloaded.mimeType,
    fileName:  downloaded.fileName,
  });
}
