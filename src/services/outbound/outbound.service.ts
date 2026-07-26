/**
 * outbound.service.ts — the single outbound dispatch pipeline.
 *
 *   Flow engine / menu engine (channel-agnostic — passes channel opaquely)
 *     → sendOutbound(ctx, payload)
 *       → renderer registry [ctx.channel]     ← the ONLY channel branch
 *         → WhatsApp / Instagram senders → Meta API
 *       → persist Message (fields derived from the LOGICAL payload)
 *       → emit "message:new"
 *
 * Contract (identical to the pre-refactor trySend* helpers):
 *  - never throws — any failure returns { sent: false } and the caller renders
 *    its existing numbered-text fallback
 *  - the Message row is persisted ONLY after a successful send, with
 *    channel-neutral messageType/metadata so the dashboard renders every
 *    channel's interactive sends without change
 *  - a renderer may report selfPersisted (WhatsApp templates) — the pipeline
 *    then skips its own persist/emit
 *
 * Adding a channel = one renderer + one inbound normalizer; nothing upstream
 * of this file changes.
 */

import prisma from "../../db/connect";
import { MessageChannel, MessageStatus } from "@prisma/client";
import { logger } from "../../utils/logger";
import { renderWhatsApp } from "./whatsapp.renderer";
import { renderInstagram } from "./instagram.renderer";
import {
  payloadPersistFields,
  type ChannelRenderer,
  type OutboundContext,
  type OutboundPayload,
} from "./payload";

const log = logger.child({ service: "outbound" });

const RENDERERS: Partial<Record<MessageChannel, ChannelRenderer>> = {
  [MessageChannel.WHATSAPP]:  renderWhatsApp,
  [MessageChannel.INSTAGRAM]: renderInstagram,
};

export type OutboundResult = {
  sent:       boolean;
  /** Set when sent === false: "unsupported" | "no_credentials" | "mock" |
   *  "disabled" | "no_contact" | "send_failed" */
  reason?:    string;
  messageId?: string | null;
};

export async function sendOutbound(
  ctx:     OutboundContext,
  payload: OutboundPayload,
  opts:    { persist?: boolean } = {},
): Promise<OutboundResult> {
  try {
    const [hotel, guest] = await Promise.all([
      prisma.hotel.findUnique({ where: { id: ctx.hotelId }, include: { config: true } }),
      prisma.guest.findUnique({ where: { id: ctx.guestId }, select: { phone: true } }),
    ]);
    if (!hotel || !guest) return { sent: false, reason: "no_contact" };

    const renderer = RENDERERS[ctx.channel];
    if (!renderer) return { sent: false, reason: "unsupported" };

    const outcome = await renderer(
      {
        hotelId:     ctx.hotelId,
        guestId:     ctx.guestId,
        hotelPhone:  hotel.phone,
        guestPhone:  guest.phone,
        hotelConfig: hotel.config,
      },
      payload,
    );

    if (!outcome.ok) return { sent: false, reason: outcome.reason };
    if (outcome.selfPersisted || opts.persist === false) {
      return { sent: true, messageId: outcome.providerMessageId };
    }

    const fields = payloadPersistFields(payload);
    const saved  = await prisma.message.create({
      data: {
        direction:   "OUT",
        fromPhone:   hotel.phone,
        toPhone:     guest.phone,
        body:        fields.body,
        messageType: fields.messageType,
        ...(fields.metadata  ? { metadata: fields.metadata as object } : {}),
        ...(fields.mediaUrl  ? { mediaUrl: fields.mediaUrl }           : {}),
        ...(fields.mimeType  ? { mimeType: fields.mimeType }           : {}),
        ...(fields.fileName  ? { fileName: fields.fileName }           : {}),
        hotelId:     ctx.hotelId,
        guestId:     ctx.guestId,
        channel:     ctx.channel,
        status:      MessageStatus.SENT,
        ...(outcome.providerMessageId ? { wamid: outcome.providerMessageId } : {}),
      },
    });

    const { emitToHotel } = await import("../../realtime/emit");
    emitToHotel(ctx.hotelId, "message:new", { message: saved });

    return { sent: true, messageId: outcome.providerMessageId };
  } catch (err) {
    log.warn(
      { err, hotelId: ctx.hotelId, guestId: ctx.guestId, channel: ctx.channel, kind: payload.kind },
      "sendOutbound: send failed — caller falls back to text",
    );
    return { sent: false, reason: "send_failed" };
  }
}
