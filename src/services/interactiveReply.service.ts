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

// ── Outbound interactive messages (what the bot SENT) ────────────────────────
// The chat stores the human-readable body text in Message.body (so the bubble
// never shows serialized JSON) and the interactive structure here.

export type InteractiveListRow = { id: string; title: string; description?: string };
export type InteractiveSection = { title?: string; rows: InteractiveListRow[] };
export type InteractiveButton  = { id: string; title: string };

export type OutboundInteractive = {
  /** "list" = tap-to-open list message; "buttons" = up to 3 reply buttons */
  type: "list" | "buttons";
  /** List messages only — label on the tap-to-open button */
  buttonLabel?: string;
  sections?: InteractiveSection[];
  buttons?: InteractiveButton[];
};

/** Shape persisted in Message.metadata (namespaced for future additions) */
export type MessageMetadata = {
  /** Inbound: what the guest tapped */
  interactiveReply?: InteractiveReply;
  /** Outbound: the interactive structure the bot sent */
  interactive?: OutboundInteractive;
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

// ── Outbound builders ────────────────────────────────────────────────────────

/** Normalize sections to plain JSON-safe rows (drop unknown keys, coerce strings) */
function normalizeSections(sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }>): InteractiveSection[] {
  return sections.map((s) => ({
    ...(s.title ? { title: String(s.title) } : {}),
    rows: (s.rows ?? []).map((r) => ({
      id:    String(r.id),
      title: String(r.title ?? ""),
      ...(r.description ? { description: String(r.description) } : {}),
    })),
  }));
}

/** Message.metadata for an outbound list message */
export function buildListMetadata(
  buttonLabel: string,
  sections:    Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }>,
): MessageMetadata {
  return { interactive: { type: "list", buttonLabel, sections: normalizeSections(sections) } };
}

/** Message.metadata for an outbound reply-buttons message */
export function buildButtonsMetadata(buttons: Array<{ id: string; title: string }>): MessageMetadata {
  return {
    interactive: {
      type:    "buttons",
      buttons: buttons.map((b) => ({ id: String(b.id), title: String(b.title) })),
    },
  };
}

/**
 * Extract an OUTBOUND interactive message (a list or reply-buttons SEND) from a
 * Meta webhook/history message object — the counterpart of
 * extractInteractiveReply. History threads and smb echoes carry the full send
 * payload: interactive.body.text + interactive.action.sections/buttons.
 * Returns null for replies (button_reply/list_reply) and everything else.
 */
export function extractOutboundInteractive(message: any): {
  bodyText:    string | null;
  messageType: "list" | "button";
  metadata:    MessageMetadata;
} | null {
  if (message?.type !== "interactive") return null;
  const ir = message.interactive;

  if (ir?.type === "list") {
    const sections = ((ir.action?.sections ?? []) as any[]).map((s) => ({
      ...(s?.title ? { title: String(s.title) } : {}),
      rows: ((s?.rows ?? []) as any[])
        .filter((r) => r?.id)
        .map((r) => ({
          id:    String(r.id),
          title: String(r.title ?? ""),
          ...(r.description ? { description: String(r.description) } : {}),
        })),
    }));
    return {
      bodyText:    ir.body?.text ? String(ir.body.text) : null,
      messageType: "list",
      metadata:    { interactive: { type: "list", buttonLabel: String(ir.action?.button ?? ""), sections } },
    };
  }

  if (ir?.type === "button") {
    const buttons = ((ir.action?.buttons ?? []) as any[])
      .map((b) => ({ id: String(b?.reply?.id ?? ""), title: String(b?.reply?.title ?? "") }))
      .filter((b) => b.id);
    return {
      bodyText:    ir.body?.text ? String(ir.body.text) : null,
      messageType: "button",
      metadata:    buildButtonsMetadata(buttons),
    };
  }

  return null;
}
