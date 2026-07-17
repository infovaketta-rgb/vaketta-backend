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
import { whatsappQueue } from "../queue/whatsapp.queue";
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

export type IncomingMessageInput = {
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

  // Per-stage timing — surfaced in one structured log line on the full reply path
  // so slow messages are diagnosable (DB setup vs bot vs Meta send) without guessing.
  const startedAt = Date.now();
  let botMs  = 0;
  let sendMs = 0;

  // ── 1. Find hotel ────────────────────────────────────────────────────────────
  const hotel = await resolveHotelByChannel(channel, toPhone);
  if (!hotel) throw new Error(`Hotel not found for channel ${channel}, recipient ${toPhone}`);

  // ── 2+dedup. Guest upsert + dedup check in parallel ─────────────────────────
  // Dedup only needs (wamid, hotelId) — independent of the guest record.
  // guest.upsert only needs (fromPhone, hotelId) — independent of dedup.
  // Both depend on hotel.id, so they run together after resolveHotelByChannel.
  let guestRaw: Awaited<ReturnType<typeof prisma.guest.upsert>> | null = null;
  let existing: Awaited<ReturnType<typeof prisma.message.findFirst>> | undefined;

  try {
    [guestRaw, existing] = await Promise.all([
      prisma.guest.upsert({
        where:  { phone_hotelId: { phone: fromPhone, hotelId: hotel.id } },
        update: {},
        create: { phone: fromPhone, hotelId: hotel.id },
      }),
      wamid
        ? prisma.message.findFirst({ where: { wamid, hotelId: hotel.id } })
        : Promise.resolve(undefined),
    ]);
  } catch (err: any) {
    if (err?.code === "P2002") {
      // Race condition on upsert — fetch the guest that beat us to it
      guestRaw = await prisma.guest.findUnique({
        where: { phone_hotelId: { phone: fromPhone, hotelId: hotel.id } },
      });
      if (!guestRaw) throw err;
    } else {
      throw err;
    }
  }

  // Deduplication early-exit (preserved from before)
  if (existing) {
    return { hotelId: hotel.id, guestId: existing.guestId!, autoReply: false, autoReplyMessage: null };
  }

  const guest = guestRaw!;

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
  // These two reads are independent — run them together (a real win once the DB
  // connection_limit is raised; harmless when it's 1).
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [lastMessage, overQuota] = await Promise.all([
    prisma.message.findFirst({
      where: {
        guestId: guest.id,
        hotelId: hotel.id,
        id:      { not: inMessage.id },
      },
      orderBy: { timestamp: "desc" },
      select:  { timestamp: true },
    }),
    isConversationOverQuota(hotel.id),
  ]);
  if (!lastMessage || lastMessage.timestamp < twentyFourHoursAgo) {
    incrementConversationUsage(hotel.id).catch((err) => log.error({ err, hotelId: hotel.id }, "incrementConversationUsage failed"));
  }

  // ── 5. Auto-reply decision ───────────────────────────────────────────────────
  if (!hotel.config) {
    return { hotelId: hotel.id, guestId: guest.id, autoReply: false, autoReplyMessage: null };
  }

  if (overQuota) {
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
    const tBot = Date.now();
    const botReply = await botProcess(hotel.id, guest.id, body ?? null, channel);
    botMs = Date.now() - tBot;
    sentReplyText = botReply === BOT_ALREADY_SENT ? null : botReply;
  }

  if (autoReplyMode === "NIGHT") {
    const tBot = Date.now();
    const botReply = await botProcess(hotel.id, guest.id, body ?? null, channel);
    botMs = Date.now() - tBot;
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

    const tSend = Date.now();
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
    sendMs = Date.now() - tSend;

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

  log.info(
    {
      hotelId: hotel.id,
      channel,
      mode:    autoReplyMode,
      replied: !!sentReplyText,
      botMs,
      sendMs,
      totalMs: Date.now() - startedAt,
    },
    "inbound processed",
  );

  return {
    hotelId:          hotel.id,
    guestId:          guest.id,
    autoReply:        autoReplyMode !== "OFF",
    autoReplyMessage: sentReplyText,
  };
}

// ── Undo-send: remove the delayed outbound job before it fires ────────────────
// Delayed sends are now durable BullMQ jobs on the `whatsapp-out` queue keyed by
// messageId (jobId = message.id). Cancelling removes that job. This is an
// OPTIMISATION only — the correctness backstop is undoSend's atomic
// `deleteMany where status=PENDING`, which wins the race even if the job already
// fired (the worker's `updateMany PENDING→SENT` then no-ops).
export async function cancelPendingSend(messageId: string): Promise<boolean> {
  try {
    const job = await whatsappQueue.getJob(messageId);
    if (!job) return false;
    await job.remove();
    return true;
  } catch (err) {
    // A remove failure is non-fatal: the DB PENDING-guard still prevents an
    // undone message from being delivered.
    log.warn({ err, messageId }, "cancelPendingSend: failed to remove delayed job");
    return false;
  }
}

/**
 * Executes a delayed outbound send. Called by the whatsapp-out worker when the
 * delay elapses. Logic is identical to the previous in-process setTimeout body:
 * atomically claim the PENDING row, send via the channel, persist status, emit.
 * Channel is re-read from the message row so both WhatsApp and Instagram delayed
 * sends work (matches sendManualReply, which is channel-aware).
 */
export async function executeDelayedSend(messageId: string): Promise<void> {
  // Atomic claim: transition PENDING → SENT in one statement.
  // If undoSend already deleted the row, updateMany returns count=0 and we exit
  // before touching the network — eliminating the send-after-cancel race.
  const claimed = await prisma.message.updateMany({
    where: { id: messageId, status: MessageStatus.PENDING },
    data:  { status: MessageStatus.SENT },
  });
  if (claimed.count === 0) return;

  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) return;

  let wamid: string | undefined;
  let finalStatus: MessageStatus = MessageStatus.SENT;

  try {
    const result = await sendChannelMessage({
      channel:   message.channel,
      toPhone:   message.toPhone,
      fromPhone: message.fromPhone,
      hotelId:   message.hotelId,
      guestId:   message.guestId ?? null,
      text:      message.body ?? "",
    });
    wamid = extractProviderMessageId(result, message.channel);
    log.info({ messageId: message.id, hotelId: message.hotelId }, "[Delay] message sent");
  } catch (err) {
    log.error({ err, messageId: message.id }, "[Delay] send failed");
    finalStatus = MessageStatus.FAILED;
  }

  await prisma.message.update({
    where: { id: message.id },
    data:  { status: finalStatus, ...(wamid ? { wamid } : {}) },
  });

  emitToHotel(message.hotelId, "message:status", { messageId: message.id, status: finalStatus });
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
  const { hotelId, guestId, fromPhone, toPhone, text, channel } = input;

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

    // Schedule the actual send as a DURABLE delayed job on the whatsapp-out queue.
    // jobId = message.id so undoSend can remove it by id (see cancelPendingSend).
    // Survives a process restart — the setTimeout approach lost the send if the
    // process died mid-delay. executeDelayedSend() runs the same atomic-claim +
    // channel-send logic the timer used to run.
    await whatsappQueue.add(
      "outbound-send",
      { messageId: message.id },
      { delay: delaySeconds * 1000, jobId: message.id },
    );

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
