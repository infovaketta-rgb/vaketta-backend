/**
 * guestChannel.service.ts
 *
 * The channel a guest is reached on. `Guest` has no channel column, so the
 * guest's most recent message is the source of truth; a guest with no
 * messages defaults to WhatsApp.
 *
 * Moved verbatim from booking.controller.ts so workers and services can share
 * it. Import-light by design: prisma + the channel enum only — never
 * realtime/emit (which imports server.ts), Express, or anything under
 * controllers/.
 */

import prisma from "../db/connect";
import { MessageChannel } from "@prisma/client";

export async function getGuestChannel(guestId: string, hotelId: string): Promise<MessageChannel> {
  const latest = await prisma.message.findFirst({
    where:   { guestId, hotelId },
    orderBy: { timestamp: "desc" },
    select:  { channel: true },
  });
  return latest?.channel ?? MessageChannel.WHATSAPP;
}
