import prisma from "../db/connect";

// ── Confirmation Sequences ──────────────────────────────────────────────────────
// An ordered list of messages (WhatsApp Templates and/or Saved Replies) a hotel
// sends when staff confirm a booking. This module owns only validation + resolution;
// the send path and dashboard UI are wired in later prompts. When resolution returns
// null the caller falls back to the legacy single-template/saved-reply selector.

export const MAX_SEQUENCE_STEPS = 10;

export type RefType = "TEMPLATE" | "SAVED_REPLY";
export type Channel = "WHATSAPP" | "INSTAGRAM";

export interface SequenceStepInput {
  refType: string;
  order:   number;
}

export interface ValidationResult {
  valid:  boolean;
  error?: string;
}

/**
 * Validates the shape of a sequence's steps for a given channel.
 *
 * WHATSAPP — the first step (lowest order) must be a TEMPLATE. WhatsApp only permits
 *   business-initiated messages to open with an approved template; a SAVED_REPLY
 *   (free-form text) is only deliverable once a template earlier in the sequence has
 *   opened the 24-hour service window. So a SAVED_REPLY at order N is allowed only if
 *   some TEMPLATE step exists at an order < N.
 * INSTAGRAM — templates don't exist; every step must be a SAVED_REPLY.
 *
 * Hard cap of MAX_SEQUENCE_STEPS steps regardless of channel.
 */
export function validateSequenceSteps(
  steps:   SequenceStepInput[],
  channel: string
): ValidationResult {
  if (steps.length === 0) {
    return { valid: false, error: "A sequence must have at least one step." };
  }
  if (steps.length > MAX_SEQUENCE_STEPS) {
    return { valid: false, error: `A sequence can have at most ${MAX_SEQUENCE_STEPS} steps.` };
  }

  // Evaluate steps in delivery order, not array order — `order` is the source of truth.
  const ordered = [...steps].sort((a, b) => a.order - b.order);

  if (channel === "INSTAGRAM") {
    const hasTemplate = ordered.some((s) => s.refType === "TEMPLATE");
    if (hasTemplate) {
      return {
        valid: false,
        error: "Instagram sequences cannot use templates — every step must be a saved reply.",
      };
    }
    return { valid: true };
  }

  if (channel === "WHATSAPP") {
    if (ordered[0]!.refType !== "TEMPLATE") {
      return {
        valid: false,
        error: "The first step of a WhatsApp sequence must be a template.",
      };
    }
    // Walk in order; a SAVED_REPLY is only valid once a TEMPLATE has appeared before it.
    let seenTemplate = false;
    for (const step of ordered) {
      if (step.refType === "TEMPLATE") {
        seenTemplate = true;
      } else if (step.refType === "SAVED_REPLY") {
        if (!seenTemplate) {
          return {
            valid: false,
            error: "A WhatsApp saved-reply step must be preceded by a template step.",
          };
        }
      } else {
        return { valid: false, error: `Unknown step type: ${step.refType}` };
      }
    }
    return { valid: true };
  }

  return { valid: false, error: `Unknown channel: ${channel}` };
}

// ── Resolution ───────────────────────────────────────────────────────────────────

export interface ResolvedSequenceStep {
  id:      string;
  order:   number;
  refType: RefType;
  refId:   string;
  /** Display title for later UI preview (template/saved-reply name), or null if the ref is missing. */
  title:   string | null;
  /** Display body for later UI preview (template body text / saved-reply body), or null if missing. */
  body:    string | null;
}

export interface ConfirmationSequenceWithSteps {
  id:            string;
  hotelId:       string;
  channel:       string;
  name:          string;
  isDefault:     boolean;
  roomTypeScope: string[];
  steps:         ResolvedSequenceStep[];
}

/**
 * Resolves the confirmation sequence to use for a booking confirmation.
 *
 * Priority:
 *   1. A sequence whose roomTypeScope contains `roomTypeId` (most specific).
 *   2. The hotel+channel sequence marked isDefault.
 *   3. null — caller falls back to the legacy single-template/saved-reply selector.
 *
 * Each step is hydrated with the actual Template/SavedReply title+body so a later
 * UI can preview the full sequence. A step whose ref no longer exists keeps its
 * refId but resolves title/body to null (it is not dropped — the caller decides).
 */
export async function resolveConfirmationSequence(
  hotelId:    string,
  channel:    string,
  roomTypeId: string | null
): Promise<ConfirmationSequenceWithSteps | null> {
  // 1. Room-type-specific match. `has` maps to Postgres `roomTypeScope @> ARRAY[id]`.
  //    Prefer the most specific scope (fewest room types) when several match.
  let sequence =
    roomTypeId
      ? await prisma.confirmationSequence.findFirst({
          where: { hotelId, channel, roomTypeScope: { has: roomTypeId } },
          orderBy: { createdAt: "asc" },
          include: { steps: { orderBy: { order: "asc" } } },
        })
      : null;

  // 2. Default fallback for this hotel + channel.
  if (!sequence) {
    sequence = await prisma.confirmationSequence.findFirst({
      where: { hotelId, channel, isDefault: true },
      orderBy: { createdAt: "asc" },
      include: { steps: { orderBy: { order: "asc" } } },
    });
  }

  // 3. Nothing configured.
  if (!sequence) return null;

  const steps = await hydrateSteps(hotelId, sequence.steps);

  return {
    id:            sequence.id,
    hotelId:       sequence.hotelId,
    channel:       sequence.channel,
    name:          sequence.name,
    isDefault:     sequence.isDefault,
    roomTypeScope: sequence.roomTypeScope,
    steps,
  };
}

// Batch-load the referenced templates + saved replies and attach title/body to each
// step (already ordered by `order` from the query). Missing refs resolve to null.
export async function hydrateSteps(
  hotelId: string,
  steps:   { id: string; order: number; refType: string; refId: string }[]
): Promise<ResolvedSequenceStep[]> {
  const templateIds  = steps.filter((s) => s.refType === "TEMPLATE").map((s) => s.refId);
  const savedReplyIds = steps.filter((s) => s.refType === "SAVED_REPLY").map((s) => s.refId);

  const [templates, savedReplies] = await Promise.all([
    templateIds.length
      ? prisma.whatsAppTemplate.findMany({
          where: { id: { in: templateIds }, hotelId },
          select: { id: true, name: true, components: true },
        })
      : Promise.resolve([]),
    savedReplyIds.length
      ? prisma.savedReply.findMany({
          where: { id: { in: savedReplyIds }, hotelId },
          select: { id: true, name: true, body: true },
        })
      : Promise.resolve([]),
  ]);

  const templateById   = new Map(templates.map((t) => [t.id, t]));
  const savedReplyById = new Map(savedReplies.map((r) => [r.id, r]));

  return steps.map((s) => {
    let title: string | null = null;
    let body:  string | null = null;
    if (s.refType === "TEMPLATE") {
      const t = templateById.get(s.refId);
      if (t) {
        const components = t.components as any;
        title = t.name;
        body  = components?.body?.text ?? t.name;
      }
    } else if (s.refType === "SAVED_REPLY") {
      const r = savedReplyById.get(s.refId);
      if (r) {
        title = r.name;
        body  = r.body;
      }
    }
    return {
      id:      s.id,
      order:   s.order,
      refType: s.refType as RefType,
      refId:   s.refId,
      title,
      body,
    };
  });
}
