/**
 * payload.ts — the channel-neutral logical outbound message model.
 *
 * A flow node (or the menu engine) describes WHAT it wants to say as an
 * OutboundPayload; a channel renderer decides HOW that becomes a Meta API call
 * (WhatsApp interactive list vs Instagram quick replies, etc.). The payload ids
 * carried in sections/buttons/cards are the single source of truth for reply
 * matching on every channel — renderers must emit them verbatim, and each
 * channel's inbound webhook normalizes taps back to `botBody = id`.
 *
 * Dependency-free at import (types + pure helpers only; interactiveReply.service
 * is itself dependency-free) so builders/tests never pull the Redis/prisma chain.
 */

import { MessageChannel } from "@prisma/client";
import {
  buildListMetadata,
  buildButtonsMetadata,
  type InteractiveButton,
  type MessageMetadata,
} from "../interactiveReply.service";

// ── Payload shapes ────────────────────────────────────────────────────────────

export type ChoiceRow = { id: string; title: string; description?: string };
export type ChoiceSection = { title: string; rows: ChoiceRow[] };

/**
 * Card shape shared by both carousel call sites (show_rooms + ARA type picker).
 * Deliberately keeps the room-card fields (price etc.) — the WhatsApp sender's
 * wire format depends on them and every current card IS a room card. Generalize
 * only when a non-room card use-case appears.
 */
export type OutboundCard = {
  imageUrl:     string;
  title:        string;
  price:        number;
  description:  string;
  /** Reply id emitted when the primary button is tapped (e.g. "room_{id}"). */
  buttonId:     string;
  buttonLabel?: string;
};

export type OutboundPayload =
  | { kind: "text";   text: string }
  | { kind: "media";  messageType: string; mediaUrl: string; mimeType: string;
      fileName?: string | null; caption?: string | null }
  /** "Pick one of N" — WA renders an interactive list, IG renders quick replies,
   *  and every channel can fall back to the caller's numbered-text rendering. */
  | { kind: "choice"; bodyText: string; buttonLabel: string;
      sections: ChoiceSection[]; footerText?: string }
  | { kind: "buttons"; bodyText: string; buttons: InteractiveButton[]; footerText?: string }
  | { kind: "cards";  bodyText: string; cards: OutboundCard[] }
  | { kind: "template"; templateId: string; values: Record<string, string> };

export type OutboundContext = {
  hotelId: string;
  guestId: string;
  channel: MessageChannel;
};

// ── Renderer contract ─────────────────────────────────────────────────────────

export type RenderContext = {
  hotelId:    string;
  guestId:    string;
  hotelPhone: string;
  /** Channel-scoped guest address — E.164 phone for WhatsApp, IGSID for Instagram. */
  guestPhone: string;
  hotelConfig: {
    metaPhoneNumberId?:             string | null;
    metaAccessTokenEncrypted?:      string | null;
    instagramAccessTokenEncrypted?: string | null;
  } | null;
};

export type RenderOutcome =
  /** selfPersisted: renderer's delegate already wrote the Message row + emitted
   *  (currently only WhatsApp templates via templates.service). */
  | { ok: true; providerMessageId: string | null; selfPersisted?: boolean }
  /** Graceful non-send — caller falls back to its text rendering.
   *  "unsupported"     the channel cannot express this payload (or exceeds caps)
   *  "no_credentials"  channel not connected for this hotel
   *  "mock"            channel's mock env flag is on (interactive kinds only)
   *  "disabled"        channel outbound is feature-flagged off */
  | { ok: false; reason: "unsupported" | "no_credentials" | "mock" | "disabled" };

export type ChannelRenderer = (ctx: RenderContext, payload: OutboundPayload) => Promise<RenderOutcome>;

// ── Persistence mapping (channel-neutral) ─────────────────────────────────────

/** How a payload persists to the Message table — messageType/body/metadata are
 *  derived from the LOGICAL payload, never from the wire format, so WhatsApp and
 *  Instagram sends of the same interaction produce identical rows (and the
 *  frontend bubbles render both without change). */
export function payloadPersistFields(payload: OutboundPayload): {
  body:        string | null;
  messageType: string;
  metadata?:   MessageMetadata;
  mediaUrl?:   string;
  mimeType?:   string;
  fileName?:   string | null;
} {
  switch (payload.kind) {
    case "text":
      return { body: payload.text, messageType: "text" };
    case "media":
      return {
        body:        payload.caption ?? null,
        messageType: payload.messageType,
        mediaUrl:    payload.mediaUrl,
        mimeType:    payload.mimeType,
        fileName:    payload.fileName ?? null,
      };
    case "choice":
      return {
        body:        payload.bodyText,
        messageType: "list",
        metadata:    buildListMetadata(payload.buttonLabel, payload.sections),
      };
    case "buttons":
      return {
        body:        payload.bodyText,
        messageType: "button",
        metadata:    buildButtonsMetadata(payload.buttons),
      };
    case "cards":
      // Same storage contract as before: RoomCarouselBubble parses {cards} JSON.
      return { body: JSON.stringify({ cards: payload.cards }), messageType: "carousel" };
    case "template":
      // Templates self-persist inside templates.service — never reached by the
      // pipeline's persist step; fields exist for completeness.
      return { body: null, messageType: "template" };
  }
}
