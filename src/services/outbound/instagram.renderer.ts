/**
 * instagram.renderer.ts — logical payload → Instagram (IG-Login messaging API).
 *
 * Capability mapping agreed in the architecture review:
 *   choice  → Quick Replies      (≤13 items, titles ≤20, descriptions dropped —
 *                                 QRs have no description surface; >13 items is
 *                                 UNSUPPORTED so the caller's numbered-text
 *                                 fallback keeps every option, never truncated)
 *   buttons → Button Template    (≤3 postback buttons, body ≤640 — over either
 *                                 cap is unsupported, no silent truncation)
 *   cards   → Generic Template   (≤10 elements; a body text is sent first as a
 *                                 plain message for parity with the WhatsApp
 *                                 carousel's embedded body)
 *   media   → attachment         (image/video/audio; document is unsupported;
 *                                 captions have no IG surface → sent as a
 *                                 follow-up text so the content isn't lost)
 *   template→ UNSUPPORTED        (WhatsApp HSM concept — send_template nodes
 *                                 take their failure edge on Instagram)
 *
 * Reply-id contract: every payload id (row id, button id, card buttonId and the
 * derived photos_ id) is emitted VERBATIM as the QR/postback payload — the
 * inbound normalizer maps taps back to botBody = id, so the flow engine matches
 * identically on both channels.
 */

import {
  sendInstagramTextMessage,
  sendInstagramQuickReplies,
  sendInstagramButtonTemplate,
  sendInstagramGenericTemplate,
  sendInstagramMediaMessage,
  type InstagramGenericElement,
} from "../instagram.send.service";
import type { ChannelRenderer } from "./payload";

export const IG_QUICK_REPLY_MAX  = 13;
export const IG_BUTTONS_MAX      = 3;
export const IG_BUTTON_BODY_MAX  = 640;
export const IG_CARDS_MAX        = 10;
const IG_MEDIA_TYPES = new Set(["image", "video", "audio"]);

function providerId(result: unknown): string | null {
  return (result as any)?.message_id ?? null;
}

export const renderInstagram: ChannelRenderer = async (ctx, payload) => {
  // Feature flag checked up front so unsupported/disabled states cost no
  // network call and fall back to text cleanly (the text path surfaces its own
  // disabled error exactly as before this refactor).
  if (payload.kind !== "text" && process.env.INSTAGRAM_OUTBOUND_ENABLED !== "true") {
    return { ok: false, reason: "disabled" };
  }

  switch (payload.kind) {
    case "text": {
      const result = await sendInstagramTextMessage({
        toPhone: ctx.guestPhone,
        text:    payload.text,
        hotelId: ctx.hotelId,
      });
      return { ok: true, providerMessageId: providerId(result) };
    }

    case "media": {
      if (!IG_MEDIA_TYPES.has(payload.messageType)) return { ok: false, reason: "unsupported" };
      const result = await sendInstagramMediaMessage({
        toPhone:   ctx.guestPhone,
        hotelId:   ctx.hotelId,
        mediaType: payload.messageType as "image" | "video" | "audio",
        mediaUrl:  payload.mediaUrl,
      });
      // IG attachments carry no caption — deliver it as a follow-up text so the
      // information isn't silently dropped.
      if (payload.caption?.trim()) {
        await sendInstagramTextMessage({ toPhone: ctx.guestPhone, text: payload.caption, hotelId: ctx.hotelId });
      }
      return { ok: true, providerMessageId: providerId(result) };
    }

    case "template":
      return { ok: false, reason: "unsupported" };
  }

  // Interactive kinds share the mock short-circuit (mirrors the WhatsApp
  // renderer: interactive falls back to text under mock; the text path then
  // mock-logs inside the sender).
  if (process.env.MOCK_INSTAGRAM_SEND === "true") return { ok: false, reason: "mock" };

  switch (payload.kind) {
    case "choice": {
      const rows = payload.sections.flatMap((s) => s.rows);
      if (rows.length === 0 || rows.length > IG_QUICK_REPLY_MAX) {
        return { ok: false, reason: "unsupported" };
      }
      // No footer surface on IG — append it to the body so instructions like
      // "Type MENU to cancel" survive the channel translation.
      const text = payload.footerText?.trim()
        ? `${payload.bodyText}\n\n${payload.footerText}`
        : payload.bodyText;
      const result = await sendInstagramQuickReplies({
        toPhone:      ctx.guestPhone,
        hotelId:      ctx.hotelId,
        text,
        quickReplies: rows.map((r) => ({ title: r.title, payload: r.id })),
      });
      return { ok: true, providerMessageId: providerId(result) };
    }

    case "buttons": {
      if (payload.buttons.length > IG_BUTTONS_MAX) return { ok: false, reason: "unsupported" };
      const text = payload.footerText?.trim()
        ? `${payload.bodyText}\n\n${payload.footerText}`
        : payload.bodyText;
      // Over the 640-char template cap → fall back to text, which keeps the
      // full body (numbered options) instead of truncating it.
      if (text.length > IG_BUTTON_BODY_MAX) return { ok: false, reason: "unsupported" };
      const result = await sendInstagramButtonTemplate({
        toPhone: ctx.guestPhone,
        hotelId: ctx.hotelId,
        text,
        buttons: payload.buttons.map((b) => ({ title: b.title, payload: b.id })),
      });
      return { ok: true, providerMessageId: providerId(result) };
    }

    case "cards": {
      if (payload.cards.length === 0) return { ok: false, reason: "unsupported" };
      const elements: InstagramGenericElement[] = payload.cards.slice(0, IG_CARDS_MAX).map((c) => ({
        title:    c.title,
        subtitle: `₹${c.price.toLocaleString("en-IN")}/night — ${c.description}`,
        imageUrl: c.imageUrl,
        buttons: [
          { title: c.buttonLabel ?? "Select Room", payload: c.buttonId },
          // Mirrors the WhatsApp sender's photos-button derivation so the
          // photos_ reply ids are identical on both channels.
          { title: "View Photos", payload: `photos_${c.buttonId.replace(/^room_/, "")}` },
        ],
      }));
      // The WA carousel embeds bodyText above the cards; IG generic templates
      // have no body — send it first as its own message (not persisted, same as
      // WA where the embedded prompt is not part of the stored carousel row).
      if (payload.bodyText?.trim()) {
        await sendInstagramTextMessage({ toPhone: ctx.guestPhone, text: payload.bodyText, hotelId: ctx.hotelId });
      }
      const result = await sendInstagramGenericTemplate({
        toPhone:  ctx.guestPhone,
        hotelId:  ctx.hotelId,
        elements,
      });
      return { ok: true, providerMessageId: providerId(result) };
    }
  }
};
