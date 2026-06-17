import { Request, Response } from "express";
import prisma from "../db/connect";
import { logger } from "../utils/logger";
import {
  validateSequenceSteps,
  hydrateSteps,
  type SequenceStepInput,
} from "../services/confirmationSequence.service";

const log = logger.child({ mod: "confirmationSequence.controller" });

const VALID_CHANNELS = new Set(["WHATSAPP", "INSTAGRAM"]);

// A fully-parsed step carries refId in addition to the validateSequenceSteps shape.
type ParsedStep = SequenceStepInput & { refId: string };

// Normalises an inbound step list into { order, refType, refId }[] and reports the
// first structural problem. Re-ordering by `order` is left to validateSequenceSteps.
function parseSteps(raw: any): { steps: ParsedStep[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { steps: [], error: "steps must be a non-empty array" };
  }
  const steps = raw.map((s: any, i: number) => ({
    order:   typeof s?.order === "number" ? s.order : i,
    refType: String(s?.refType ?? ""),
    refId:   String(s?.refId ?? ""),
  }));
  for (const s of steps) {
    if (!s.refId) return { steps, error: "every step needs a refId" };
    if (s.refType !== "TEMPLATE" && s.refType !== "SAVED_REPLY") {
      return { steps, error: `invalid refType: ${s.refType}` };
    }
  }
  return { steps };
}

// Verify every refId belongs to this hotel and matches its declared refType, so a
// hotel can't reference another tenant's template/saved-reply by id.
async function assertRefsBelongToHotel(
  hotelId: string,
  steps:   { refType: string; refId: string }[]
): Promise<string | null> {
  const templateIds   = steps.filter((s) => s.refType === "TEMPLATE").map((s) => s.refId);
  const savedReplyIds = steps.filter((s) => s.refType === "SAVED_REPLY").map((s) => s.refId);

  const [templates, savedReplies] = await Promise.all([
    templateIds.length
      ? prisma.whatsAppTemplate.findMany({ where: { id: { in: templateIds }, hotelId }, select: { id: true } })
      : Promise.resolve([]),
    savedReplyIds.length
      ? prisma.savedReply.findMany({ where: { id: { in: savedReplyIds }, hotelId }, select: { id: true } })
      : Promise.resolve([]),
  ]);

  const foundTemplates   = new Set(templates.map((t) => t.id));
  const foundSavedReplies = new Set(savedReplies.map((r) => r.id));

  for (const s of steps) {
    if (s.refType === "TEMPLATE" && !foundTemplates.has(s.refId)) {
      return `Template not found: ${s.refId}`;
    }
    if (s.refType === "SAVED_REPLY" && !foundSavedReplies.has(s.refId)) {
      return `Saved reply not found: ${s.refId}`;
    }
  }
  return null;
}

// ── GET /confirmation-sequences?channel=WHATSAPP|INSTAGRAM ────────────────────────

export async function listConfirmationSequences(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const channel = String(req.query.channel ?? "");

    if (!VALID_CHANNELS.has(channel)) {
      return res.status(400).json({ error: "channel must be WHATSAPP or INSTAGRAM" });
    }

    const sequences = await prisma.confirmationSequence.findMany({
      where:   { hotelId, channel },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      include: { steps: { orderBy: { order: "asc" } } },
    });

    const result = await Promise.all(
      sequences.map(async (seq) => ({
        id:            seq.id,
        hotelId:       seq.hotelId,
        channel:       seq.channel,
        name:          seq.name,
        isDefault:     seq.isDefault,
        roomTypeScope: seq.roomTypeScope,
        steps:         await hydrateSteps(hotelId, seq.steps),
      }))
    );

    return res.json(result);
  } catch (err) {
    log.error({ err }, "list confirmation sequences failed");
    return res.status(500).json({ error: "Failed to load confirmation sequences" });
  }
}

// ── POST /confirmation-sequences ─────────────────────────────────────────────────

export async function createConfirmationSequence(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const { channel, name, isDefault, roomTypeScope, steps: rawSteps } = req.body ?? {};

    if (!VALID_CHANNELS.has(String(channel))) {
      return res.status(400).json({ error: "channel must be WHATSAPP or INSTAGRAM" });
    }
    if (!String(name ?? "").trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const scope = Array.isArray(roomTypeScope) ? roomTypeScope.map(String) : [];

    const { steps, error: parseErr } = parseSteps(rawSteps);
    if (parseErr) return res.status(400).json({ error: parseErr });

    const validation = validateSequenceSteps(steps, channel);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    const refErr = await assertRefsBelongToHotel(hotelId, steps);
    if (refErr) return res.status(400).json({ error: refErr });

    const makeDefault = Boolean(isDefault);

    const created = await prisma.$transaction(async (tx) => {
      // Only one default per hotel+channel — clear the others first.
      if (makeDefault) {
        await tx.confirmationSequence.updateMany({
          where: { hotelId, channel, isDefault: true },
          data:  { isDefault: false },
        });
      }
      return tx.confirmationSequence.create({
        data: {
          hotelId,
          channel,
          name: String(name).trim(),
          isDefault: makeDefault,
          roomTypeScope: scope,
          steps: {
            create: steps.map((s) => ({ order: s.order, refType: s.refType, refId: s.refId })),
          },
        },
        include: { steps: { orderBy: { order: "asc" } } },
      });
    });

    return res.status(201).json({
      id:            created.id,
      hotelId:       created.hotelId,
      channel:       created.channel,
      name:          created.name,
      isDefault:     created.isDefault,
      roomTypeScope: created.roomTypeScope,
      steps:         await hydrateSteps(hotelId, created.steps),
    });
  } catch (err) {
    log.error({ err }, "create confirmation sequence failed");
    return res.status(500).json({ error: "Failed to create confirmation sequence" });
  }
}

// ── PUT /confirmation-sequences/:id ──────────────────────────────────────────────

export async function updateConfirmationSequence(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const id      = String(req.params.id);
    const { name, isDefault, roomTypeScope, steps: rawSteps } = req.body ?? {};

    const existing = await prisma.confirmationSequence.findFirst({ where: { id, hotelId } });
    if (!existing) return res.status(404).json({ error: "Confirmation sequence not found" });

    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ error: "name cannot be empty" });
    }

    const { steps, error: parseErr } = parseSteps(rawSteps);
    if (parseErr) return res.status(400).json({ error: parseErr });

    // Steps are always validated against the sequence's (immutable) channel.
    const validation = validateSequenceSteps(steps, existing.channel);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    const refErr = await assertRefsBelongToHotel(hotelId, steps);
    if (refErr) return res.status(400).json({ error: refErr });

    const makeDefault = isDefault !== undefined ? Boolean(isDefault) : existing.isDefault;
    const scope = roomTypeScope !== undefined
      ? (Array.isArray(roomTypeScope) ? roomTypeScope.map(String) : [])
      : existing.roomTypeScope;

    const updated = await prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.confirmationSequence.updateMany({
          where: { hotelId, channel: existing.channel, isDefault: true, id: { not: id } },
          data:  { isDefault: false },
        });
      }
      // Full step replace — delete then recreate inside the transaction.
      await tx.confirmationSequenceStep.deleteMany({ where: { sequenceId: id } });
      return tx.confirmationSequence.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: String(name).trim() } : {}),
          isDefault:     makeDefault,
          roomTypeScope: scope,
          steps: {
            create: steps.map((s) => ({ order: s.order, refType: s.refType, refId: s.refId })),
          },
        },
        include: { steps: { orderBy: { order: "asc" } } },
      });
    });

    return res.json({
      id:            updated.id,
      hotelId:       updated.hotelId,
      channel:       updated.channel,
      name:          updated.name,
      isDefault:     updated.isDefault,
      roomTypeScope: updated.roomTypeScope,
      steps:         await hydrateSteps(hotelId, updated.steps),
    });
  } catch (err) {
    log.error({ err }, "update confirmation sequence failed");
    return res.status(500).json({ error: "Failed to update confirmation sequence" });
  }
}

// ── DELETE /confirmation-sequences/:id ───────────────────────────────────────────

export async function deleteConfirmationSequence(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId as string;
    const id      = String(req.params.id);

    const existing = await prisma.confirmationSequence.findFirst({ where: { id, hotelId } });
    if (!existing) return res.status(404).json({ error: "Confirmation sequence not found" });

    // Steps cascade-delete via the FK (onDelete: Cascade).
    await prisma.confirmationSequence.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    log.error({ err }, "delete confirmation sequence failed");
    return res.status(500).json({ error: "Failed to delete confirmation sequence" });
  }
}
