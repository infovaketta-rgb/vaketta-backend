import prisma from "../db/connect";
import { normalizePhone } from "../utils/phone";
import { emitToHotel } from "../realtime/emit";
import { MessageChannel, MessageStatus } from "@prisma/client";
import { logger } from "../utils/logger";
import { extractMediaFromWebhookMessage } from "./media.service";
import { extractInteractiveReply, buildReplyMetadata, extractOutboundInteractive } from "./interactiveReply.service";
import { persistEchoedOutboundMessage } from "./echoPersist.service";
import { historyMediaQueue } from "../queue/historyMedia.queue";

const log = logger.child({ service: "history" });

const VALID_MSG_TYPES = new Set(["text", "image", "video", "audio", "document", "sticker"]);

// ── Hotel resolution helper ───────────────────────────────────────────────────
// Tries metaPhoneNumberId first, falls back to normalised display_phone_number.

async function resolveHotel(
  phoneNumberId:      string | undefined,
  displayPhoneNumber: string | undefined,
): Promise<{ id: string; phone: string } | null> {
  if (phoneNumberId) {
    const cfg = await prisma.hotelConfig.findFirst({
      where:   { metaPhoneNumberId: phoneNumberId },
      include: { hotel: true },
    });
    if (cfg?.hotel) return { id: cfg.hotel.id, phone: cfg.hotel.phone };
  }
  if (displayPhoneNumber) {
    const norm  = normalizePhone(displayPhoneNumber);
    const hotel = await prisma.hotel.findUnique({
      where:  { phone: norm },
      select: { id: true, phone: true },
    });
    if (hotel) return hotel;
  }
  return null;
}

// ── History webhook handler ───────────────────────────────────────────────────
// Handles change.field === "history" payloads delivered by Meta during
// WhatsApp Coexistence history sync.  Chunks arrive sequentially; each is
// acked immediately so Meta does not retry.
//
// IMPORTANT: no logIncomingMessage, no bot pipeline, no message:new socket
// events — historical messages must be stored silently.

export async function processHistoryWebhook(value: any): Promise<void> {
  try {
    const phoneNumberId      = value?.metadata?.phone_number_id      as string | undefined;
    const displayPhoneNumber = value?.metadata?.display_phone_number as string | undefined;

    const hotel = await resolveHotel(phoneNumberId, displayPhoneNumber);
    if (!hotel) {
      log.warn({ phoneNumberId, displayPhoneNumber }, "history webhook: hotel not found");
      return;
    }

    // Idempotency guard — skip entirely if already complete
    const current = await prisma.hotel.findUnique({
      where:  { id: hotel.id },
      select: { historySyncStatus: true, historySyncStarted: true },
    });
    if (current?.historySyncStatus === "complete") {
      log.info({ hotelId: hotel.id }, "history sync already complete — skipping chunk");
      return;
    }

    const historyChunks = value?.history as any[] | undefined;
    if (!historyChunks?.length) return;

    const hotelPhoneNorm = normalizePhone(hotel.phone);
    let startedSet = current?.historySyncStarted != null;

    for (const chunk of historyChunks) {
      // Meta sends progress/phase as numbers OR strings depending on payload
      // version — coerce via String() before any numeric/string op. `phase` is
      // usually a numeric enum, so NEVER assume it is a string (calling
      // .toUpperCase() on a number throws "toUpperCase is not a function").
      const progressRaw = chunk?.metadata?.progress;
      const progress    = Math.min(100, Math.max(0, parseInt(String(progressRaw ?? ""), 10) || 0));
      const phase       = String(chunk?.metadata?.phase ?? "").toUpperCase();
      const isFinal     = progress >= 100 || phase === "COMPLETE";

      // Persist sync state
      const syncUpdate: Record<string, unknown> = {
        historySyncStatus:   isFinal ? "complete" : "in_progress",
        historySyncProgress: isFinal ? 100 : progress,
      };
      if (!startedSet) {
        syncUpdate.historySyncStarted = new Date();
        startedSet = true;
      }
      if (isFinal) syncUpdate.historySyncCompleted = new Date();

      await prisma.hotel.update({ where: { id: hotel.id }, data: syncUpdate });

      // Process every thread in this chunk
      const threads = chunk?.threads as any[] | undefined;
      if (threads?.length) {
        for (const thread of threads) {
          await processThread(thread, hotel.id, hotelPhoneNorm);
        }
      }

      // Emit a single progress event per chunk — no per-message noise
      emitToHotel(hotel.id, "history:sync_progress", {
        progress: isFinal ? 100 : progress,
        status:   isFinal ? "complete" : "in_progress",
      });

      log.info({ hotelId: hotel.id, progress, isFinal, threads: threads?.length ?? 0 },
        "history chunk processed");
    }
  } catch (err) {
    log.error({ err }, "processHistoryWebhook error");
  }
}

async function processThread(
  thread:          any,
  hotelId:         string,
  hotelPhoneNorm:  string,
): Promise<void> {
  const guestPhoneRaw = thread?.id as string | undefined;
  if (!guestPhoneRaw) return;

  const guestPhone = normalizePhone(guestPhoneRaw);

  const guest = await prisma.guest.upsert({
    where:  { phone_hotelId: { phone: guestPhone, hotelId } },
    create: { phone: guestPhone, hotelId },
    update: {},
  });

  const messages = thread?.messages as any[] | undefined;
  if (!messages?.length) return;

  for (const msg of messages) {
    const wamid = (msg?.id as string | undefined) ?? null;
    if (!wamid) continue;

    const fromNorm  = normalizePhone((msg.from as string) ?? "");
    const direction = fromNorm === hotelPhoneNorm ? "OUT" : "IN";
    const fromPhone = direction === "OUT" ? hotelPhoneNorm : guestPhone;
    const toPhone   = direction === "OUT" ? guestPhone     : hotelPhoneNorm;

    const msgType = (msg.type as string) || "text";
    let body =
      msg.text?.body         ??
      msg.image?.caption     ??
      msg.video?.caption     ??
      msg.document?.caption  ??
      msg.audio?.caption     ??
      null;

    // Interactive replies in history (guest tapped a list row / button) — same
    // treatment as the live webhook: store the human-readable title as the
    // body, keep the payload id + type in metadata for the Message Details UI.
    const reply = extractInteractiveReply(msg);
    if (reply) body = reply.title ?? reply.id;

    // Outbound interactive sends (the bot's own list/button messages appearing
    // in history): store the human-readable body text + the interactive
    // structure in metadata — same shape the live persist sites write — so the
    // bubble renders like WhatsApp instead of a serialized payload.
    const outbound = reply ? null : extractOutboundInteractive(msg);
    if (outbound?.bodyText) body = outbound.bodyText;

    // Honour original timestamp — never use new Date()
    const timestamp = msg.timestamp
      ? new Date(parseInt(String(msg.timestamp)) * 1000)
      : new Date();

    // Map history_context.status → internal MessageStatus
    const histCtx   = (msg.history_context?.status as string | undefined) ?? "";
    const status: MessageStatus =
      histCtx === "read"      ? MessageStatus.READ      :
      histCtx === "delivered" ? MessageStatus.DELIVERED :
      histCtx === "sent"      ? MessageStatus.SENT      :
      direction === "IN"      ? MessageStatus.RECEIVED  :
                                MessageStatus.SENT;

    // Media messages (image/video/audio/document/sticker): the history payload
    // carries a media ID, not a downloadable URL — same shape as live inbound
    // messages. Reuse extractMediaFromWebhookMessage (no duplicated parsing),
    // write a `pending://{mediaId}` placeholder so the row exists immediately,
    // then queue the actual Graph-API-fetch + R2-upload so bulk import never
    // blocks on network I/O per message. historyMedia.worker backfills it via
    // the SAME downloadMetaMedia() pipeline live inbound uses.
    const media = extractMediaFromWebhookMessage(msg);

    const messageData = {
      direction,
      fromPhone,
      toPhone,
      body,
      messageType: outbound ? outbound.messageType
                            : VALID_MSG_TYPES.has(msgType) ? msgType : "text",
      hotelId,
      guestId:   guest.id,
      channel:   MessageChannel.WHATSAPP,
      status,
      wamid,
      timestamp,
      ...(reply ? { metadata: buildReplyMetadata(reply) } : outbound ? { metadata: outbound.metadata } : {}),
      ...(media
        ? { mediaUrl: `pending://${media.mediaId}`, mimeType: media.mimeType, fileName: media.fileName }
        : {}),
    };

    // Upsert on the (hotelId, wamid) unique constraint — DB-safe dedup instead
    // of a check-then-create race. Meta re-delivering the same chunk, two
    // chunks processed concurrently, or a reconnect re-syncing the same
    // history all resolve to the SAME row: the first write creates it, every
    // later attempt hits the unique index and no-ops via `update: {}` instead
    // of racing to insert a duplicate.
    const created = await prisma.message.upsert({
      where:  { hotelId_wamid: { hotelId, wamid } },
      create: messageData,
      update: {}, // already stored — leave the existing row untouched
    });

    if (media) {
      await historyMediaQueue.add(
        "history-media",
        { messageId: created.id, mediaId: media.mediaId, mimeType: media.mimeType, hotelPhone: hotelPhoneNorm },
        { jobId: created.id },
      );
    }
  }
}

// ── SMB Message Echoes handler ────────────────────────────────────────────────
// Handles change.field === "smb_message_echoes" — messages the hotel sends
// from the WhatsApp Business App while Coexistence mode is active.
// Stored as OUT messages with message:new socket emission so the chat thread
// stays in sync; bot pipeline is never invoked.

export async function processSmbMessageEcho(value: any): Promise<void> {
  try {
    const phoneNumberId      = value?.metadata?.phone_number_id      as string | undefined;
    const displayPhoneNumber = value?.metadata?.display_phone_number as string | undefined;
    const msgArr             = value?.messages as any[] | undefined;
    if (!msgArr?.length) return;

    const hotel = await resolveHotel(phoneNumberId, displayPhoneNumber);
    if (!hotel) {
      log.warn({ phoneNumberId }, "smb_message_echoes: hotel not found");
      return;
    }

    const hotelPhoneNorm = normalizePhone(hotel.phone);

    for (const msg of msgArr) {
      const wamid         = (msg.id  as string | undefined) ?? null;
      const guestPhoneRaw = normalizePhone((msg.to as string) ?? "");
      if (!guestPhoneRaw) continue;

      const msgType = (msg.type as string) || "text";
      let body =
        msg.text?.body        ??
        msg.image?.caption    ??
        msg.video?.caption    ??
        msg.document?.caption ??
        null;

      // Echoed interactive sends: store body text + structure in metadata,
      // same shape as processThread / the live persist sites.
      const outbound = extractOutboundInteractive(msg);
      if (outbound?.bodyText) body = outbound.bodyText;

      // Guest upsert + (hotelId, wamid) dedup-upsert + emit-only-when-new all
      // live in the shared echo persister (also used by Instagram is_echo events).
      await persistEchoedOutboundMessage({
        hotelId:     hotel.id,
        fromPhone:   hotelPhoneNorm,
        guestPhone:  guestPhoneRaw,
        body,
        messageType: outbound ? outbound.messageType
                              : VALID_MSG_TYPES.has(msgType) ? msgType : "text",
        ...(outbound ? { metadata: outbound.metadata } : {}),
        wamid,
        channel:     MessageChannel.WHATSAPP,
      });
    }
  } catch (err) {
    log.error({ err }, "processSmbMessageEcho error");
  }
}
