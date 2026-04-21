import prisma from "../db/connect";
import { MessageStatus } from "@prisma/client";
import { emitToHotel } from "../realtime/emit";
import { shouldAutoReply } from "../automation/shouldAutoReply";
import { processMessage as botProcess } from "../automation/botEngine";
import { buildMenuMessage } from "../automation/buildMenuResponse";
import { resetSession } from "./session.service";
import { incrementConversationUsage, isConversationOverQuota } from "./usage.service";
import { sendTextMessage } from "./whatsapp.send.service";

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
  channel?: string;
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
  const { fromPhone, toPhone, body, messageType, mediaUrl, mimeType, fileName, wamid } = input;

  // ── 1. Find hotel ────────────────────────────────────────────────────────────
  const hotel = await prisma.hotel.findUnique({
    where:   { phone: toPhone },
    include: { config: true },
  });
  if (!hotel) throw new Error(`Hotel not found for phone ${toPhone}`);

  // ── Deduplication: Meta re-delivers webhooks on timeout — skip if already seen ─
  if (wamid) {
    const existing = await prisma.message.findFirst({ where: { wamid, hotelId: hotel.id } });
    if (existing) {
      return { hotelId: hotel.id, guestId: existing.guestId!, autoReply: false, autoReplyMessage: null };
    }
  }

  // ── 2. Find or create guest (per-hotel scope) ────────────────────────────────
  const guest = await prisma.guest.upsert({
    where:  { phone_hotelId: { phone: fromPhone, hotelId: hotel.id } },
    update: {},
    create: { phone: fromPhone, hotelId: hotel.id },
  });

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
      ...(wamid ? { wamid } : {}),
    },
  });

  emitToHotel(hotel.id, "message:new", { message: inMessage });

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
    incrementConversationUsage(hotel.id).catch((err) => console.error("[Usage] incrementConversationUsage failed:", err));
  }

  // ── 5. Auto-reply decision ───────────────────────────────────────────────────
  if (!hotel.config) {
    return { hotelId: hotel.id, guestId: guest.id, autoReply: false, autoReplyMessage: null };
  }

  if (await isConversationOverQuota(hotel.id)) {
    console.warn(`[Quota] Hotel ${hotel.id} has exceeded conversation limit — bot silenced`);
    return { hotelId: hotel.id, guestId: guest.id, autoReply: false, autoReplyMessage: null };
  }

  const autoReplyMode = shouldAutoReply(
    {
      autoReplyEnabled:  hotel.config.autoReplyEnabled,
      businessStartHour: hotel.config.businessStartHour,
      businessEndHour:   hotel.config.businessEndHour,
      timezone:          hotel.config.timezone,
    },
    guest.lastHandledByStaff
  );

  let sentReplyText: string | null = null;

  if (autoReplyMode === "DAY") {
    sentReplyText = await botProcess(hotel.id, guest.id, body ?? null);
  }

  if (autoReplyMode === "NIGHT") {
    // Show the night message AND the menu so guests can still browse services
    const nightMsg = hotel.config.nightMessage;
    const menu     = await buildMenuMessage(hotel.id);
    sentReplyText  = menu ? `${nightMsg}\n\n${menu}` : nightMsg;
  }

  // ── 6. Send outbound bot reply directly (no BullMQ — worker is a separate process) ──
  if (sentReplyText) {
    let wamid: string | undefined;
    let finalStatus: MessageStatus = MessageStatus.FAILED;

    try {
      const result = await sendTextMessage({
        toPhone:   fromPhone,
        fromPhone: toPhone,
        hotelId:   hotel.id,
        guestId:   guest.id,
        text:      sentReplyText,
      });
      wamid = (result as any)?.messages?.[0]?.id ?? undefined;
      finalStatus = MessageStatus.SENT;
    } catch (err) {
      console.error("❌ [Bot] sendTextMessage failed:", err);
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
}): Promise<{ message: any; delaySeconds: number | null }> {
  const { hotelId, guestId, fromPhone, toPhone, text } = input;

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
      },
    });

    emitToHotel(hotelId, "message:new", { message });

    // Schedule the actual send inside this server process using setTimeout.
    // No separate worker process required for short delays (1–60s).
    const timer = setTimeout(async () => {
      _pendingTimers.delete(message.id);

      // Guard: message may have been undo-deleted while we were waiting
      const stillPending = await prisma.message.findFirst({
        where: { id: message.id, status: MessageStatus.PENDING },
      });
      if (!stillPending) return;

      let wamid: string | undefined;
      let finalStatus: MessageStatus = MessageStatus.FAILED;

      try {
        const result = await sendTextMessage({ toPhone, fromPhone, hotelId, guestId, text });
        wamid = (result as any)?.messages?.[0]?.id ?? undefined;
        finalStatus = MessageStatus.SENT;
        console.log("[Delay] Message sent, wamid:", wamid ?? "unknown");
      } catch (err) {
        console.error("[Delay] sendTextMessage error:", err);
      }

      await prisma.message.update({
        where: { id: message.id },
        data:  { status: finalStatus, ...(wamid ? { wamid } : {}) },
      });

      // Push status update to all open dashboard tabs
      emitToHotel(hotelId, "message:status", { messageId: message.id, status: finalStatus });
    }, delaySeconds * 1000);

    _pendingTimers.set(message.id, timer);

    return { message, delaySeconds };
  }

  // ── Immediate send (no delay) ─────────────────────────────────────────────
  let wamid: string | undefined;
  let finalStatus: MessageStatus = MessageStatus.FAILED;

  try {
    const result = await sendTextMessage({ toPhone, fromPhone, hotelId, guestId, text });
    wamid = (result as any)?.messages?.[0]?.id ?? undefined;
    console.log("[Meta] Message sent, wamid:", wamid ?? "unknown");
    finalStatus = MessageStatus.SENT;
  } catch (err) {
    console.error("[Meta] sendTextMessage error:", err);
    finalStatus = MessageStatus.FAILED;
  }

  const message = await prisma.message.create({
    data: {
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
    throw new Error("WhatsApp delivery failed — message not sent");
  }

  return { message, delaySeconds: null };
}
