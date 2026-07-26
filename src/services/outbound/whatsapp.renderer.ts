/**
 * whatsapp.renderer.ts — logical payload → WhatsApp Cloud API.
 *
 * Thin mapping layer over the existing whatsapp.send.service senders; every wire
 * format, cap, and truncation rule stays where it always lived (the senders).
 * Behavior contract preserved from the pre-refactor trySend* helpers:
 *  - interactive kinds: MOCK_WHATSAPP_SEND → not sent (caller text-falls-back);
 *    missing Meta credentials → not sent
 *  - text/media kinds: delegate unconditionally — sendTextMessage/sendMediaMessage
 *    handle mock/no-creds themselves by no-op'ing (returns null), and the row is
 *    still persisted (e.g. the ARA occupancy notice)
 *  - templates: templates.service owns send + persist + emit (selfPersisted)
 */

import {
  sendTextMessage,
  sendMediaMessage,
  sendListMessage,
  sendButtonMessage,
  sendCarouselMessage,
} from "../whatsapp.send.service";
import { decryptWhatsAppToken } from "../../utils/encryption.utils";
import type { ChannelRenderer } from "./payload";

export const renderWhatsApp: ChannelRenderer = async (ctx, payload) => {
  switch (payload.kind) {
    case "text": {
      const result = await sendTextMessage({
        toPhone:   ctx.guestPhone,
        fromPhone: ctx.hotelPhone,
        hotelId:   ctx.hotelId,
        guestId:   ctx.guestId,
        text:      payload.text,
      });
      return { ok: true, providerMessageId: (result as any)?.messages?.[0]?.id ?? null };
    }

    case "media": {
      const result = await sendMediaMessage({
        toPhone:     ctx.guestPhone,
        hotelId:     ctx.hotelId,
        messageType: payload.messageType,
        mediaUrl:    payload.mediaUrl,
        mimeType:    payload.mimeType,
        fileName:    payload.fileName ?? null,
        caption:     payload.caption ?? null,
      });
      return { ok: true, providerMessageId: (result as any)?.messages?.[0]?.id ?? null };
    }

    case "template": {
      // Lazy import — templates.service is heavy and only needed here.
      const { sendTemplateMessage } = await import("../templates.service");
      const result = await sendTemplateMessage(ctx.hotelId, ctx.guestId, payload.templateId, payload.values);
      return { ok: true, providerMessageId: (result as any)?.messageId ?? null, selfPersisted: true };
    }
  }

  // ── Interactive kinds (choice / buttons / cards) ────────────────────────────
  if (process.env["MOCK_WHATSAPP_SEND"] === "true") return { ok: false, reason: "mock" };

  const phoneNumberId = ctx.hotelConfig?.metaPhoneNumberId ?? "";
  const encryptedTok  = ctx.hotelConfig?.metaAccessTokenEncrypted ?? "";
  if (!phoneNumberId || !encryptedTok) return { ok: false, reason: "no_credentials" };
  const accessToken = decryptWhatsAppToken(encryptedTok);

  switch (payload.kind) {
    case "choice": {
      const wamid = await sendListMessage(ctx.guestPhone, phoneNumberId, accessToken, {
        bodyText:    payload.bodyText,
        buttonLabel: payload.buttonLabel,
        sections:    payload.sections,
        ...(payload.footerText ? { footerText: payload.footerText } : {}),
      });
      return { ok: true, providerMessageId: wamid };
    }

    case "buttons": {
      const wamid = await sendButtonMessage(ctx.guestPhone, phoneNumberId, accessToken, {
        bodyText: payload.bodyText,
        buttons:  payload.buttons,
        ...(payload.footerText ? { footerText: payload.footerText } : {}),
      });
      return { ok: true, providerMessageId: wamid };
    }

    case "cards": {
      // Meta requires ≥2 cards in a WhatsApp carousel.
      if (payload.cards.length < 2) return { ok: false, reason: "unsupported" };
      const wamid = await sendCarouselMessage(
        ctx.guestPhone, phoneNumberId, accessToken, payload.bodyText, payload.cards,
      );
      return { ok: true, providerMessageId: wamid };
    }
  }
};
