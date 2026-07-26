import { MessageChannel } from "@prisma/client";
import { logIncomingMessage, resolveHotelByChannel } from "./message.service";
import { persistEchoedOutboundMessage } from "./echoPersist.service";
import { buildReplyMetadata, type MessageMetadata } from "./interactiveReply.service";
import { logger } from "../utils/logger";
export { encryptInstagramToken, decryptInstagramToken } from "../utils/encryption.utils";

const log = logger.child({ service: "instagram" });

export async function processInstagramInboundEvent(event: any): Promise<void> {
  const senderId    = event.sender?.id    as string | undefined;
  const recipientId = event.recipient?.id as string | undefined;
  // Postback events (generic/button template taps) carry their mid on
  // event.postback, not event.message.
  const mid         = (event.message?.mid ?? event.postback?.mid) as string | undefined;
  const text        = event.message?.text as string | null ?? null;

  if (!senderId || !recipientId || !mid) return;

  // ── Echo events (message.is_echo === true) ─────────────────────────────────
  // Meta mirrors messages the business SENT (e.g. staff replying from the
  // Instagram app) back to every subscription of the sending account. The ID
  // roles are flipped vs. inbound: sender = business account, recipient = the
  // guest's account-scoped IGSID. Never run these through the inbound flow —
  // resolving a hotel by the guest IGSID can only ever fail.
  if (event.message?.is_echo === true) {
    const hotel = await resolveHotelByChannel(MessageChannel.INSTAGRAM, senderId);
    if (!hotel) {
      // Expected when another IG professional account is subscribed to the same
      // Meta app (its echoes reach us too) — permanently unresolvable, skip
      // without throwing so the job never burns retries or dead letters.
      log.debug({ senderId, mid }, "instagram echo: sender is not a connected hotel — skipping");
      return;
    }
    if (!text) {
      // Attachment-only echoes (reels, media shares) — not stored yet, matching
      // the text-only outbound Instagram messages Vaketta itself sends.
      log.debug({ senderId, mid }, "instagram echo: no text body — skipping");
      return;
    }
    await persistEchoedOutboundMessage({
      hotelId:     hotel.id,
      fromPhone:   hotel.phone,          // same business-side identifier as staff replies sent from Vaketta
      guestPhone:  recipientId,          // guest IGSID in this account's scope
      body:        text,
      messageType: "text",
      wamid:       mid,                  // (hotelId, wamid) unique constraint dedups redeliveries
      channel:     MessageChannel.INSTAGRAM,
    });
    return;
  }

  // ── Normal inbound (guest → hotel) ──────────────────────────────────────────
  // Pre-check hotel resolution so an unknown recipient is a permanent skip, not
  // a thrown error: logIncomingMessage's throw would make BullMQ retry an event
  // that can never succeed. Transient failures (DB down) still throw below and
  // still retry.
  const hotel = await resolveHotelByChannel(MessageChannel.INSTAGRAM, recipientId);
  if (!hotel) {
    log.warn({ recipientId, senderId, mid }, "instagram inbound: no connected hotel for recipient — skipping");
    return;
  }

  // ── Interactive-reply normalization ─────────────────────────────────────────
  // Same contract as the WhatsApp webhook: body = the human-readable title the
  // guest tapped, botBody = the payload id the flow engine matches on
  // (opt_N, room_*, plan_N, MOD_*…), metadata = { interactiveReply }.
  //  • Quick-reply tap  → message.quick_reply.payload (+ message.text = title)
  //  • Postback tap     → postback.payload / postback.title (button + generic
  //    templates; stored as "button_reply" — semantically a button tap, and the
  //    dashboard already knows that label)
  let body    = text;
  let botBody: string | null = null;
  let metadata: MessageMetadata | null = null;

  const quickReplyPayload = event.message?.quick_reply?.payload;
  const postback          = event.postback;
  if (quickReplyPayload) {
    botBody  = String(quickReplyPayload);
    metadata = buildReplyMetadata({ type: "quick_reply", id: botBody, title: text, description: null });
  } else if (postback?.payload) {
    botBody  = String(postback.payload);
    body     = postback.title ? String(postback.title) : botBody;
    metadata = buildReplyMetadata({
      type:        "button_reply",
      id:          botBody,
      title:       postback.title ? String(postback.title) : null,
      description: null,
    });
  }

  // Delegate to the shared inbound pipeline — this gives Instagram the same
  // guest upsert, socket emit, bot auto-reply, push notification, and usage
  // tracking that WhatsApp receives via the same function.
  await logIncomingMessage({
    fromPhone:   senderId,
    toPhone:     recipientId,
    body,
    messageType: "text",
    wamid:       mid,
    channel:     MessageChannel.INSTAGRAM,
    ...(botBody  ? { botBody }  : {}),
    ...(metadata ? { metadata } : {}),
  });
}
