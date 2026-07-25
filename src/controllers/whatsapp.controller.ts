import { Request, Response } from "express";
import { normalizePhone } from "../utils/phone";
import prisma from "../db/connect";
import { MessageStatus } from "@prisma/client";
import { emitToHotel } from "../realtime/emit";
import { extractMediaFromWebhookMessage } from "../services/media.service";
import { extractInteractiveReply, buildReplyMetadata, MessageMetadata } from "../services/interactiveReply.service";
import { whatsappInboundQueue } from "../queue/whatsappInbound.queue";
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

    // Interactive replies (list/button/quick_reply taps) — collapse to a text
    // message. The STORED body is the human-readable title the guest actually
    // tapped (what renders in the chat bubble); the payload id travels
    // separately as `botBody` so the flow engine can still match patterns like
    // "room_<roomId>" / "opt_N" / "plan_N", and the full reply is persisted in
    // Message.metadata.interactiveReply for the Message Details UI.
    let botBody:  string | null          = null;
    let metadata: MessageMetadata | null = null;
    if (messageType === "interactive" || messageType === "button") {
      const reply = extractInteractiveReply(message);
      if (!reply) {
        log.info({ messageType, irType: message.interactive?.type }, "skipping interactive message with no reply id");
        return res.sendStatus(200);
      }
      messageType = "text";
      body        = reply.title ?? reply.id; // no title from Meta → old behaviour (id, hidden by the UI filter)
      botBody     = reply.id;
      metadata    = buildReplyMetadata(reply);
    }

    const SUPPORTED_TYPES = new Set(["text", "image", "video", "audio", "document", "sticker"]);

    if (!SUPPORTED_TYPES.has(messageType)) {
      log.info({ messageType }, "skipping unsupported message type");
      return res.sendStatus(200);
    }

    const mediaInfo = extractMediaFromWebhookMessage(message);

    // Build the durable job payload. For media we persist a `pending://` bubble
    // first (inside logIncomingMessage), then the worker downloads the file to R2.
    const input = mediaInfo
      ? {
          fromPhone, toPhone, body, messageType,
          mediaUrl: `pending://${mediaInfo.mediaId}`,
          mimeType: mediaInfo.mimeType,
          fileName: mediaInfo.fileName,
          wamid, botBody, metadata,
        }
      : { fromPhone, toPhone, body, messageType, mediaUrl: null, mimeType: null, fileName: null, wamid, botBody, metadata };

    // Enqueue BEFORE ACK so a Redis failure makes Meta retry (no lost message).
    // The bot/AI/send pipeline then runs in a bounded-concurrency worker instead
    // of an unbounded in-process promise. jobId = wamid dedups Meta re-deliveries;
    // logIncomingMessage also dedups by wamid at the DB level as a second guard.
    try {
      await whatsappInboundQueue.add(
        "inbound",
        { input, media: mediaInfo ?? null },
        wamid ? { jobId: wamid } : {},
      );
    } catch (err) {
      log.error({ err, fromPhone, toPhone }, "failed to enqueue inbound message — 500 so Meta retries");
      return res.sendStatus(500);
    }

    return res.sendStatus(200);
  } catch (err) {
    log.error({ err }, "WhatsApp webhook error");
    return res.sendStatus(200); // always ACK to prevent Meta retries
  }
}
