import prisma from "../db/connect";
import { whatsappQueue } from "../queue/whatsapp.queue";
import { MessageStatus } from "@prisma/client";
import { emitToHotel } from "../realtime/emit";
import { shouldAutoReply } from "../automation/shouldAutoReply";
import { processMessage as botProcess } from "../automation/botEngine";
import { buildMenuMessage } from "../automation/buildMenuResponse";
import { resetSession } from "./session.service";
import { incrementConversationUsage } from "./usage.service";
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

  // ── 4. Usage — count only new conversations (IDLE or first message) ──────────
  const existingSession = await prisma.conversationSession.findUnique({
    where:  { guestId_hotelId: { guestId: guest.id, hotelId: hotel.id } },
    select: { state: true },
  });
  if (!existingSession || existingSession.state === "IDLE") {
    incrementConversationUsage(hotel.id).catch(() => {});
  }

  // ── 5. Auto-reply decision ───────────────────────────────────────────────────
  if (!hotel.config) {
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

  // ── 6. Enqueue outbound message ──────────────────────────────────────────────
  if (sentReplyText) {
    const outMessage = await prisma.message.create({
      data: {
        direction:   "OUT",
        fromPhone:   toPhone,
        toPhone:     fromPhone,
        body:        sentReplyText,
        messageType: "text",
        hotelId:     hotel.id,
        guestId:     guest.id,
        status:      MessageStatus.PENDING,
      },
    });

    emitToHotel(hotel.id, "message:new", { message: outMessage });
    await whatsappQueue.add("send", { messageId: outMessage.id });
  }

  return {
    hotelId:          hotel.id,
    guestId:          guest.id,
    autoReply:        autoReplyMode !== "OFF",
    autoReplyMessage: sentReplyText,
  };
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
    // Create PENDING message first
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

    // Enqueue with BullMQ delay — job won't run until after delaySeconds
    const job = await whatsappQueue.add(
      "send",
      { messageId: message.id },
      { delay: delaySeconds * 1000 }
    );

    // Store BullMQ job ID so it can be cancelled via undo-send
    const updated = await prisma.message.update({
      where: { id: message.id },
      data:  { jobId: job.id ?? null },
    });

    emitToHotel(hotelId, "message:new", { message: updated });
    return { message: updated, delaySeconds };
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
