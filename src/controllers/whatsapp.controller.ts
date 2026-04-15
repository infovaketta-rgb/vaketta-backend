import { Request, Response } from "express";
import { logIncomingMessage } from "../services/message.service";
import { normalizePhone } from "../utils/phone";
import prisma from "../db/connect";
import { MessageStatus } from "@prisma/client";
import { emitToHotel } from "../realtime/emit";
import { extractMediaFromWebhookMessage, downloadMetaMedia } from "../services/media.service";

const META_STATUS_MAP: Record<string, MessageStatus> = {
  sent:      MessageStatus.SENT,
  delivered: MessageStatus.DELIVERED,
  read:      MessageStatus.READ,
  failed:    MessageStatus.FAILED,
};

// Bug 1: GET handler for Meta webhook verification challenge
export function verifyWhatsAppWebhook(req: Request, res: Response) {
  const mode      = req.query["hub.mode"] as string | undefined;
  const token     = req.query["hub.verify_token"] as string | undefined;
  const challenge = req.query["hub.challenge"] as string | undefined;

  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN ;

  if (mode === "subscribe" && token === expectedToken) {
    console.log("✅ WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }

  console.warn("❌ WhatsApp webhook verification failed", { mode, token });
  return res.sendStatus(403);
}

export async function handleWhatsAppWebhook(req: Request, res: Response) {
  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;

    // Handle Meta status updates (sent / delivered / read / failed)
    const statusUpdate = value?.statuses?.[0];
    if (statusUpdate) {
      const wamid      = statusUpdate.id as string | undefined;
      const metaStatus = statusUpdate.status as string | undefined;
      const newStatus  = metaStatus ? META_STATUS_MAP[metaStatus] : undefined;

      if (wamid && newStatus) {
        const updated = await prisma.message.findFirst({ where: { wamid } });
        if (updated) {
          await prisma.message.update({
            where: { id: updated.id },
            data: { status: newStatus },
          });
          emitToHotel(updated.hotelId, "message:status", {
            messageId: updated.id,
            status: newStatus,
          });
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
      console.warn("⚠️ Missing phone numbers in webhook payload", { rawFrom, rawTo });
      return res.sendStatus(200);
    }

    const fromPhone   = normalizePhone(rawFrom);
    const toPhone     = normalizePhone(rawTo);
    const messageType = (message.type as string) || "text";
    const wamid       = (message.id as string | undefined) ?? null;

    // Extract text body (text messages) or caption (media messages)
    const body = message.text?.body ?? message[messageType]?.caption ?? null;

    // Download media if this is a media message
    let mediaUrl: string | null = null;
    let mimeType: string | null = null;
    let fileName: string | null = null;

    const mediaInfo = extractMediaFromWebhookMessage(message);
    if (mediaInfo) {
      const downloaded = await downloadMetaMedia(
        mediaInfo.mediaId,
        mediaInfo.mimeType,
        toPhone,
      );
      if (downloaded) {
        mediaUrl = downloaded.localUrl;
        mimeType = downloaded.mimeType;
        fileName = downloaded.fileName;
      } else {
        // No credentials — store mediaId as placeholder so type info is preserved
        mediaUrl = `meta://${mediaInfo.mediaId}`;
        mimeType = mediaInfo.mimeType;
        fileName = mediaInfo.fileName;
      }
    }

    await logIncomingMessage({ fromPhone, toPhone, body, messageType, mediaUrl, mimeType, fileName, wamid });

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ WhatsApp webhook error:", err);
    return res.sendStatus(200); // always ACK to prevent Meta retries
  }
}
