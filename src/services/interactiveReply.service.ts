/**
 * interactiveReply.service.ts
 *
 * Pure parsing of WhatsApp interactive REPLIES (what a guest tapped) out of a
 * Meta webhook message object. Shared by the live webhook controller and the
 * Coexistence history importer so both store the same shape:
 *   body     → the human-readable title the guest actually saw and selected
 *   botBody  → the payload id the flow engine matches on (room_*, opt_N, plan_N…)
 *   metadata → { interactiveReply: { type, id, title } } persisted on Message
 *
 * Dependency-free (no prisma/redis at import) so it unit-tests in isolation,
 * same convention as bookingAllocation.ts / stayDuration.ts.
 */

export type InteractiveReplyType = "button_reply" | "list_reply" | "quick_reply";

export type InteractiveReply = {
  /** Which interactive surface produced the tap */
  type: InteractiveReplyType;
  /** Payload id — what the flow engine matches (e.g. "opt_2", "room_<id>", "plan_1") */
  id: string;
  /** Human-readable label the guest saw on the button / list row */
  title: string | null;
  /** List rows can carry a secondary description line */
  description: string | null;
};

/** Shape persisted in Message.metadata (namespaced for future additions) */
export type MessageMetadata = {
  interactiveReply: InteractiveReply;
};

/**
 * Extract an interactive reply from a Meta webhook/history message object.
 * Handles:
 *   • type "interactive" + interactive.button_reply / interactive.list_reply
 *   • type "button" (template/carousel quick_reply taps — payload + text)
 * Returns null for anything else, including OUTBOUND interactive messages
 * (interactive.type "list"/"button" — those are sends, not replies).
 */
export function extractInteractiveReply(message: any): InteractiveReply | null {
  const type = message?.type as string | undefined;

  if (type === "interactive") {
    const ir = message.interactive;
    if (ir?.type === "button_reply" && ir.button_reply?.id) {
      return {
        type:        "button_reply",
        id:          String(ir.button_reply.id),
        title:       ir.button_reply.title ? String(ir.button_reply.title) : null,
        description: null,
      };
    }
    if (ir?.type === "list_reply" && ir.list_reply?.id) {
      return {
        type:        "list_reply",
        id:          String(ir.list_reply.id),
        title:       ir.list_reply.title ? String(ir.list_reply.title) : null,
        description: ir.list_reply.description ? String(ir.list_reply.description) : null,
      };
    }
    return null;
  }

  if (type === "button" && message.button?.payload) {
    return {
      type:        "quick_reply",
      id:          String(message.button.payload),
      title:       message.button.text ? String(message.button.text) : null,
      description: null,
    };
  }

  return null;
}

/** Message.metadata payload for a parsed reply */
export function buildReplyMetadata(reply: InteractiveReply): MessageMetadata {
  return {
    interactiveReply: {
      type:        reply.type,
      id:          reply.id,
      title:       reply.title,
      description: reply.description,
    },
  };
}
