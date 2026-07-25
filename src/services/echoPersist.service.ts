import prisma from "../db/connect";
import { MessageChannel, MessageStatus } from "@prisma/client";
import { emitToHotel } from "../realtime/emit";

/**
 * Shared persistence for ECHOED outbound messages — messages the business sent
 * from outside Vaketta (WhatsApp Business App smb_message_echoes, Instagram
 * is_echo events) that Meta mirrors back to us via webhook.
 *
 * Guarantees (same contract for every channel):
 *  - guest row exists (upsert by (phone, hotelId))
 *  - dedup is DB-level via the (hotelId, wamid) unique constraint — a redelivered
 *    or concurrently-processed echo resolves to the SAME row (upsert, update: {})
 *  - "message:new" is emitted only when this call actually created the row, so
 *    the UI is never re-notified for an already-stored echo
 *
 * Kept dependency-light on purpose (prisma + emit only — no queue/redis imports)
 * so channel services and their tests can use it without the Redis-at-import chain.
 */
export async function persistEchoedOutboundMessage(input: {
  hotelId:      string;
  /** Business-side identifier stored on OUT rows (hotel phone for both channels). */
  fromPhone:    string;
  /** Guest identifier in this channel's scope (normalized phone / IGSID). */
  guestPhone:   string;
  body:         string | null;
  messageType:  string;
  metadata?:    unknown;
  wamid:        string | null;
  channel:      MessageChannel;
}): Promise<{ message: any; isNew: boolean }> {
  const { hotelId, fromPhone, guestPhone, body, messageType, metadata, wamid, channel } = input;

  const guest = await prisma.guest.upsert({
    where:  { phone_hotelId: { phone: guestPhone, hotelId } },
    create: { phone: guestPhone, hotelId },
    update: {},
  });

  const messageData = {
    direction:   "OUT",
    fromPhone,
    toPhone:     guestPhone,
    body,
    messageType,
    ...(metadata ? { metadata } : {}),
    hotelId,
    guestId:     guest.id,
    channel,
    status:      MessageStatus.SENT,
    ...(wamid ? { wamid } : {}),
  };

  let saved;
  let isNew = true;
  if (wamid) {
    // DB-safe dedup via the (hotelId, wamid) unique constraint — an echo
    // re-delivered by Meta resolves to the same row instead of racing a
    // check-then-create. Detect whether this call created the row (vs.
    // hit an existing one) so message:new is never re-emitted for an
    // echo that was already stored.
    const before = await prisma.message.findUnique({
      where:  { hotelId_wamid: { hotelId, wamid } },
      select: { id: true },
    });
    isNew = !before;
    saved = await prisma.message.upsert({
      where:  { hotelId_wamid: { hotelId, wamid } },
      create: messageData,
      update: {},
    });
  } else {
    // No wamid to key on — plain create, same fallback behaviour as before.
    saved = await prisma.message.create({ data: messageData });
  }

  if (isNew) {
    emitToHotel(hotelId, "message:new", { message: saved });
  }

  return { message: saved, isNew };
}
