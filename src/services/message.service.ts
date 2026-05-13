import prisma from "../db/connect";
import { MessageStatus } from "@prisma/client";
import { emitToHotel } from "../realtime/emit";
import { shouldAutoReply } from "../automation/shouldAutoReply";
import { processMessage as botProcess } from "../automation/botEngine";
import { resetSession } from "./session.service";
import { incrementConversationUsage, isConversationOverQuota } from "./usage.service";
import { sendPushToHotelStaff } from "./push.service";
import { logger } from "../utils/logger";
import { MessageChannel } from "@prisma/client";

import { sendChannelMessage } from "./channel.send.service";
const log = logger.child({ service: "message" });

// ── Channel-aware hotel resolution ───────────────────────────────────────────
// WhatsApp  → hotel matched by its phone number (the Meta-registered number)
// Instagram → hotel matched via HotelConfig.instagramBusinessAccountId
async function resolveHotelByChannel(channel: MessageChannel, recipientId: string) {
  if (channel === MessageChannel.INSTAGRAM) {
    const cfg = await prisma.hotelConfig.findUnique({
      where:   { instagramBusinessAccountId: recipientId },
      include: { hotel: { include: { config: true } } },
    });
    return cfg?.hotel ?? null;
  }
  // Default: WHATSAPP — look up hotel by phone
  return prisma.hotel.findUnique({
    where:   { phone: recipientId },
    include: { config: true },
  });
}

// ── Provider message-id extraction ───────────────────────────────────────────
// Centralises the channel-specific response shape differences so call sites
// don't need to branch on channel themselves.
function extractProviderMessageId(result: unknown, channel: MessageChannel): string | undefined {
  if (channel === MessageChannel.INSTAGRAM) {
    return (result as any)?.message_id ?? (result as any)?.recipient_id ?? undefined;
  }
  // WhatsApp
  return (result as any)?.messages?.[0]?.id;
}

type IncomingMessageInput = {
  fromPhone:   string;
  toPhone:     string;
  body?:       string | null;
  messageType: string;
  mediaUrl?:   string | null;
  mimeType?:   string | null;
  fileName?:   string | null;
  wamid?:      string | null;
  /** Channel this message arrived on. Defaults to "whatsapp". Future: "instagram" | "call" */
  channel?: MessageChannel;
};

type IncomingMessageResult = {
  hotelId:          string;
  guestId:          string;
  autoReply:        boolean;
  autoReplyMessage: string | null;
};

export async function logIncomingMessage(
  input: IncomingMessageInput
): Promise<IncomingMessageResult> {
  const { fromPhone, toPhone, body, messageType, mediaUrl, mimeType, fileName, wamid ,channel = MessageChannel.WHATSAPP} = input;

  // ── 1. Find hotel ────────────────────────────────────────────────────────────
  const hotel = await resolveHotelByChannel(channel, toPhone);
  if (!hotel) throw new Error(`Hotel not found for channel ${channel}, recipient ${toPhone}`);

  // ── Deduplication: Meta re-delivers webhooks on timeout — skip if already seen ─
  if (wamid) {
    const existing = await prisma.message.findFirst({ where: { wamid, hotelId: hotel.id } });
    if (existing) {
      return { hotelId: hotel.id, guestId: existing.guestId!, autoReply: false, autoReplyMessage: null };
    }
  }

  // ── 2. Find or create guest (per-hotel scope) ────────────────────────────────
  // Replace the guest upsert with this retry-safe version
let guest;
try {
  guest = await prisma.guest.upsert({
    where:  { phone_hotelId: { phone: fromPhone, hotelId: hotel.id } },
    update: {},
    create: { phone: fromPhone, hotelId: hotel.id },
  });
} catch (err: any) {
  if (err?.code === "P2002") {
    // Race condition — another job created the guest, just fetch it
    guest = await prisma.guest.findUnique({
      where: { phone_hotelId: { phone: fromPhone, hotelId: hotel.id } },
    });
    if (!guest) throw err;
  } else {
    throw err;
  }
}

  // Skip saving if message has no content at all
  if (!body && !mediaUrl) {
    return { hotelId: hotel.id, guestId: guest.id, autoReply: false, autoReplyMessage: null };
  }

  // ── 3. Persist incoming message ──────────────────────────────────────────────
  const inMessage = await prisma.message.create({
    data: {
      direction:   "IN",
      fromPhone,
      toPhone,
      body:        body      ?? null,
      messageType,
      mediaUrl:    mediaUrl  ?? null,
      mimeType:    mimeType  ?? null,
      fileName:    fileName  ?? null,
      hotelId:     hotel.id,
      guestId:     guest.id,
      status:      MessageStatus.RECEIVED,
      channel,
      ...(wamid ? { wamid } : {}),
    },
  });

  emitToHotel(hotel.id, "message:new", { message: inMessage });

  // Pending media: bubble already shown — skip bot until R2 upload completes
  if (mediaUrl?.startsWith("pending://")) {
    return { hotelId: hotel.id, guestId: guest.id, autoReply: false, autoReplyMessage: null };
  }

  // ── 4. Usage — count only new 24-hour conversation windows ─────────────────
  // A "new conversation" = first ever message OR last message was >24 h ago.
  // We exclude the message we just created so we're looking at prior history.
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const lastMessage = await prisma.message.findFirst({
    where: {
      guestId: guest.id,
      hotelId: hotel.id,
      id:      { not: inMessage.id },
    },
    orderBy: { timestamp: "desc" },
    select:  { timestamp: true },
  });
  if (!lastMessage || lastMessage.timestamp < twentyFourHoursAgo) {
    incrementConversationUsage(hotel.id).catch((err) => log.error({ err, hotelId: hotel.id }, "incrementConversationUsage failed"));
  }

  // ── 5. Auto-reply decision ───────────────────────────────────────────────────
  if (!hotel.config) {
    return { hotelId: hotel.id, guestId: guest.id, autoReply: false, autoReplyMessage: null };
  }

  if (await isConversationOverQuota(hotel.id)) {
    log.warn({ hotelId: hotel.id }, "conversation quota exceeded — bot silenced");
    return { hotelId: hotel.id, guestId: guest.id, autoReply: false, autoReplyMessage: null };
  }

  const autoReplyMode = shouldAutoReply(
    {
      autoReplyEnabled:  hotel.config.autoReplyEnabled,
      businessStartHour: hotel.config.businessStartHour,
      businessEndHour:   hotel.config.businessEndHour,
      timezone:          hotel.config.timezone,
      allDay:            (hotel.config as any).allDay ?? false,
    },
    guest.lastHandledByStaff
  );

  let sentReplyText: string | null = null;

  // Sentinel returned by botProcess when the flow dispatched a non-text reply
  // itself (e.g. an interactive carousel) — meaning the upstream pipeline MUST
  // NOT also send a text. Distinct from `null` ("bot has nothing to say"),
  // which in NIGHT mode would still send the standalone nightMsg.
  const BOT_ALREADY_SENT = "ALREADY_SENT";

  if (autoReplyMode === "DAY") {
    const botReply = await botProcess(hotel.id, guest.id, body ?? null);
    sentReplyText = botReply === BOT_ALREADY_SENT ? null : botReply;
  }

  if (autoReplyMode === "NIGHT") {
    const botReply = await botProcess(hotel.id, guest.id, body ?? null);
    if (botReply === BOT_ALREADY_SENT) {
      // Bot already dispatched its own reply (carousel) — suppress nightMsg too.
      sentReplyText = null;
    } else {
      const nightMsg = hotel.config.nightMessage;
      sentReplyText  = botReply ? `${nightMsg}\n\n${botReply}` : nightMsg;
    }
  }

  if (autoReplyMode === "OFF") {
    const guestLabel = guest.name ?? fromPhone;
    sendPushToHotelStaff(hotel.id, {
      title: "New message",
      body:  `${guestLabel}: ${body?.slice(0, 100) ?? "(media)"}`,
      icon:  "/vchat icon.png",
      url:   "/dashboard/chats",
    }).catch((err) => log.error({ err }, "push notification failed"));
    emitToHotel(hotel.id, "staff:notification", { guestId: guest.id, guestName: guestLabel, body: body ?? null });
  }

  // ── 6. Send outbound bot reply directly (no BullMQ — worker is a separate process) ──
  if (sentReplyText) {
    let wamid: string | undefined;
    let finalStatus: MessageStatus = MessageStatus.FAILED;

    try {
      const result = await sendChannelMessage({
        channel,
        toPhone:   fromPhone,
        fromPhone: toPhone,
        hotelId:   hotel.id,
        guestId:   guest.id,
        text:      sentReplyText,
      });
      wamid = extractProviderMessageId(result, channel);
      finalStatus = MessageStatus.SENT;
    } catch (err) {
      log.error({ err, hotelId: hotel.id, guestId: guest.id }, "bot sendTextMessage failed");
    }

    const outMessage = await prisma.message.create({
      data: {
        direction:   "OUT",
        fromPhone:   toPhone,
        toPhone:     fromPhone,
        body:        sentReplyText,
        messageType: "text",
        hotelId:     hotel.id,
        guestId:     guest.id,
        status:      finalStatus,
        channel,
        ...(wamid ? { wamid } : {}),
      },
    });

    emitToHotel(hotel.id, "message:new", { message: outMessage });
  }

  return {
    hotelId:          hotel.id,
    guestId:          guest.id,
    autoReply:        autoReplyMode !== "OFF",
    autoReplyMessage: sentReplyText,
  };
}

// ── Undo-send registry — maps messageId → active setTimeout handle ────────────
// Lives in the server process; no separate worker needed for short delays.
const _pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Cancel a pending delayed send. Returns true if the timer existed. */
export function cancelPendingSend(messageId: string): boolean {
  const timer = _pendingTimers.get(messageId);
  if (!timer) return false;
  clearTimeout(timer);
  _pendingTimers.delete(messageId);
  return true;
}

// ── Manual staff reply ────────────────────────────────────────────────────────

export async function sendManualReply(input: {
  hotelId:   string;
  guestId:   string;
  fromPhone: string; // hotel number
  toPhone:   string; // guest number
  text:      string;
  channel:   MessageChannel;
}): Promise<{ message: any; delaySeconds: number | null }> {
  const { hotelId, guestId, fromPhone, toPhone, text ,channel = MessageChannel.WHATSAPP } = input;

  // Mark as handled by staff and reset bot session
  await prisma.guest.updateMany({
    where: { id: guestId, hotelId },
    data:  { lastHandledByStaff: true },
  });
  await resetSession(guestId, hotelId);

  // ── Check if message delay is enabled for this hotel ──────────────────────
  const config = await prisma.hotelConfig.findUnique({ where: { hotelId } });
  const delayEnabled = config?.messageDelayEnabled ?? false;
  const delaySeconds = delayEnabled
    ? Math.max(1, Math.min(60, config?.messageDelaySeconds ?? 10))
    : null;

  if (delayEnabled && delaySeconds) {
    // Create PENDING message immediately so it shows in the UI
    const message = await prisma.message.create({
      data: {
        direction:   "OUT",
        fromPhone,
        toPhone,
        body:        text,
        messageType: "text",
        hotelId,
        guestId,
        status:      MessageStatus.PENDING,
        channel ,
      },
    });

    emitToHotel(hotelId, "message:new", { message });

    // Schedule the actual send inside this server process using setTimeout.
    // No separate worker process required for short delays (1–60s).
    const timer = setTimeout(async () => {
      _pendingTimers.delete(message.id);

      // Atomic claim: transition PENDING → SENT in one statement.
      // If undoSend already deleted the row, updateMany returns count=0 and
      // we exit before touching the network — eliminating the send-after-cancel race.
      const claimed = await prisma.message.updateMany({
        where: { id: message.id, status: MessageStatus.PENDING },
        data:  { status: MessageStatus.SENT },
      });
      if (claimed.count === 0) return;

      let wamid: string | undefined;
      let finalStatus: MessageStatus = MessageStatus.SENT;

      try {
        const result = await sendChannelMessage({ channel, toPhone, fromPhone, hotelId, guestId, text });
        wamid = extractProviderMessageId(result, channel);
        log.info({ messageId: message.id, hotelId }, "[Delay] message sent");
      } catch (err) {
        log.error({ err, messageId: message.id }, "[Delay] send failed");
        finalStatus = MessageStatus.FAILED;
      }

      await prisma.message.update({
        where: { id: message.id },
        data:  { status: finalStatus, ...(wamid ? { wamid } : {}) },
      });

      emitToHotel(hotelId, "message:status", { messageId: message.id, status: finalStatus });
    }, delaySeconds * 1000);

    _pendingTimers.set(message.id, timer);

    return { message, delaySeconds };
  }

  // ── Immediate send (no delay) ─────────────────────────────────────────────
  let wamid: string | undefined;
  let finalStatus: MessageStatus = MessageStatus.FAILED;

  try {
    const result = await sendChannelMessage({ channel, toPhone, fromPhone, hotelId, guestId, text });
    wamid = extractProviderMessageId(result, channel);
    log.info({ wamid }, "message sent");
    finalStatus = MessageStatus.SENT;
  } catch (err) {
    log.error({ err }, "send channel message error");
    finalStatus = MessageStatus.FAILED;
  }

  const message = await prisma.message.create({
    data: {
      channel,
      direction:   "OUT",
      fromPhone,
      toPhone,
      body:        text,
      messageType: "text",
      hotelId,
      guestId,
      status:      finalStatus,
      ...(wamid ? { wamid } : {}),
    },
  });

  emitToHotel(hotelId, "message:new", { message });

  if (finalStatus === MessageStatus.FAILED) {
    throw new Error("Message delivery failed — message not sent");
  }

  return { message, delaySeconds: null };
}
