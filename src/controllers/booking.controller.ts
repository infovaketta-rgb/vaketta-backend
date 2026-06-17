import { Request, Response } from "express";
import { createBookingService, updateBookingService } from "../services/booking.service";
import prisma from "../db/connect";
import { BookingStatus, MessageChannel } from "@prisma/client";
import { logger } from "../utils/logger";
import { emitToHotel } from "../realtime/emit";
import { sendTemplateMessage } from "../services/templates.service";
import { sendChannelMessage } from "../services/channel.send.service";
import { interpolate } from "../automation/interpolate";
import { resolveConfirmationSequence } from "../services/confirmationSequence.service";
import { confirmationSequenceQueue } from "../queue/confirmationSequence.queue";
import { confirmationJobId, reconstructStatus } from "../services/confirmationStatus";
import type {
  ConfirmationStepJob,
  ConfirmationSequenceJobData,
} from "../workers/confirmationSequence.types";

const log = logger.child({ service: "booking" });

export async function createBooking(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;

    const {
      guestId,
      guestName,
      roomTypeId,
      checkIn,
      checkOut,
      pricePerNight,
      advancePaid,
    } = req.body;

    if (!guestId || !guestName || !roomTypeId || !checkIn || !checkOut) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    const guestOwned = await prisma.guest.findFirst({ where: { id: guestId, hotelId } });
    if (!guestOwned) {
      return res.status(404).json({ error: "Guest not found" });
    }

    const booking = await createBookingService({
      hotelId,
      guestId,
      guestName,
      roomTypeId,
      checkIn,
      checkOut,
      pricePerNight,
      advancePaid,
    });

    res.json(booking);
  } catch (err: any) {
    log.error({ err: err.message }, "create booking failed");
    res.status(500).json({ error: "Create booking failed" });
  }
}

export async function getBookings(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;

    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip  = (page - 1) * limit;

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where: { hotelId },
        include: { guest: true, roomType: true },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.booking.count({ where: { hotelId } }),
    ]);

    return res.json({ data: bookings, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    log.error({ err }, "get bookings failed");
    return res.status(500).json({ error: "Failed to fetch bookings" });
  }
}
export async function updateBookingStatus(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { bookingId } = req.params;
    const { status } = req.body;

    const validStatuses = Object.values(BookingStatus);
    if (!bookingId || !status) {
      return res.status(400).json({ error: "bookingId and status required" });
    }
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
    }

    const result = await prisma.booking.updateMany({
      where: { id: bookingId, hotelId },
      data: { status },
    });

    if (result.count === 0) {
      return res.status(404).json({ success: false, message: "Booking not found or unauthorized" });
    }

    emitToHotel(hotelId, "booking:updated", { bookingId, status });
    return res.json({ success: true });
  } catch (err) {
    log.error({ err }, "update booking status failed");
    res.status(500).json({ error: "Failed to update status" });
  }
}

export async function editBooking(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { bookingId } = req.params;
    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    const { guestName, roomTypeId, checkIn, checkOut, pricePerNight, advancePaid, rooms } = req.body;

    // Serialize concurrent edits on the same booking to prevent lost updates.
    let booking: Awaited<ReturnType<typeof updateBookingService>>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${bookingId}))`;
      booking = await updateBookingService({
        id: bookingId,
        hotelId,
        guestName,
        roomTypeId,
        checkIn,
        checkOut,
        ...(pricePerNight !== undefined ? { pricePerNight: Number(pricePerNight) } : {}),
        ...(advancePaid   !== undefined ? { advancePaid:   Number(advancePaid)   } : {}),
        ...(Array.isArray(rooms)        ? { rooms }                               : {}),
      });
    });

    res.json(booking!);
    emitToHotel(hotelId, "booking:updated", { booking: booking! });
  } catch (err: any) {
    log.error({ err: err.message }, "edit booking failed");
    res.status(400).json({ error: err.message || "Failed to edit booking" });
  }
}

export async function getBookingById(req: Request, res: Response) {
  try {
    const hotelId   = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    const booking = await prisma.booking.findFirst({
      where:   { id: bookingId, hotelId },
      include: {
        guest:    true,
        roomType: true,
        rooms:    { include: { roomType: { select: { name: true } } } },
      },
    });

    if (!booking) return res.status(404).json({ error: "Booking not found" });
    return res.json(booking);
  } catch (err) {
    log.error({ err }, "get booking by id failed");
    return res.status(500).json({ error: "Failed to fetch booking" });
  }
}

export async function bulkUpdateBookingStatus(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { ids, status } = req.body as { ids?: string[]; status?: string };

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: "Maximum 500 booking IDs per request" });
    }
    const validStatuses = Object.values(BookingStatus);
    if (!status || !validStatuses.includes(status as BookingStatus)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
    }

    const result = await prisma.booking.updateMany({
      where: { id: { in: ids }, hotelId },
      data:  { status: status as BookingStatus },
    });

    for (const bookingId of ids) {
      emitToHotel(hotelId, "booking:updated", { bookingId, status });
    }

    return res.json({ updated: result.count });
  } catch (err) {
    log.error({ err }, "bulk booking status update failed");
    return res.status(500).json({ error: "Failed to update bookings" });
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function formatDateShort(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function getGuestChannel(guestId: string, hotelId: string): Promise<MessageChannel> {
  const latest = await prisma.message.findFirst({
    where:   { guestId, hotelId },
    orderBy: { timestamp: "desc" },
    select:  { channel: true },
  });
  return latest?.channel ?? MessageChannel.WHATSAPP;
}

function buildVars(booking: any): Record<string, string> {
  const roomName =
    booking.rooms?.length > 0
      ? `${booking.rooms.length} room${booking.rooms.length !== 1 ? "s" : ""}`
      : (booking.roomType?.name ?? "");
  return {
    guestName:  booking.guestName || booking.guest?.name || "",
    bookingRef: booking.referenceNumber || booking.id,
    checkIn:    formatDateShort(new Date(booking.checkIn)),
    checkOut:   formatDateShort(new Date(booking.checkOut)),
    roomType:   roomName,
  };
}

function interpolateTemplateBody(bodyText: string, vars: Record<string, string>): string {
  return bodyText.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_: string, k: string) => vars[k] ?? `{{${k}}}`
  );
}

// Extract unique variable names from template body text ({{varName}} or {{1}}).
function extractVarsFromText(bodyText: string): string[] {
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  const seen = new Set<string>();
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyText ?? "")) !== null) {
    const name = m[1]!;
    if (!seen.has(name)) { seen.add(name); names.push(name); }
  }
  return names;
}

// Extract unique variable names from a template's components (body text).
function extractTemplateVars(components: any): string[] {
  return extractVarsFromText(components?.body?.text ?? "");
}

// Build the {name, defaultValue} descriptor list staff see for a template step.
// defaultValue is auto-derived from the booking (buildVars) where possible; "" means
// the value must be supplied by staff before sending. Mirrors the legacy confirm flow.
function buildStepVariables(bodyText: string, vars: Record<string, string>): { name: string; defaultValue: string }[] {
  return extractVarsFromText(bodyText).map((name) => ({ name, defaultValue: vars[name] ?? "" }));
}

// ── GET /bookings/:id/confirm-options ─────────────────────────────────────────
//
// Returns available message options for the guest's channel:
//   WHATSAPP → { channel, options: [{ id, name, bodyPreview }] }  (APPROVED templates only)
//   INSTAGRAM → { channel, options: [{ id, name, bodyPreview }] } (all saved replies)

export async function confirmBookingOptions(req: Request, res: Response) {
  try {
    const hotelId     = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    const booking = await prisma.booking.findFirst({
      where:   { id: bookingId, hotelId },
      include: { guest: true, roomType: true, rooms: { include: { roomType: { select: { name: true } } } } },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const channel = await getGuestChannel(booking.guestId, hotelId);
    const vars    = buildVars(booking);

    const hotelCfg = await prisma.hotelConfig.findUnique({
      where:  { hotelId },
      select: { botMessages: true },
    });
    const botMsgs = (hotelCfg?.botMessages ?? {}) as Record<string, string>;

    if (channel === MessageChannel.WHATSAPP) {
      const templates = await prisma.whatsAppTemplate.findMany({
        where:   { hotelId, status: "APPROVED" },
        orderBy: { name: "asc" },
        select:  { id: true, name: true, language: true, components: true },
      });
      const options = templates.map((t) => {
        const comps    = t.components as any;
        const bodyText = comps?.body?.text ?? t.name;
        const varNames = extractTemplateVars(comps);
        const variables = varNames.map((name) => ({ name, defaultValue: vars[name] ?? "" }));
        return {
          id:          t.id,
          name:        t.name,
          language:    t.language,
          bodyPreview: interpolateTemplateBody(bodyText, vars),
          variables,
        };
      });
      const defaultId = botMsgs.defaultConfirmTemplateId || null;
      return res.json({ channel, options, defaultId });
    }

    // Instagram
    const savedReplies = await prisma.savedReply.findMany({
      where:   { hotelId },
      orderBy: { name: "asc" },
      select:  { id: true, name: true, category: true, body: true },
    });
    const options = savedReplies.map((r) => ({
      id:          r.id,
      name:        r.name,
      category:    r.category ?? null,
      bodyPreview: interpolate(r.body, vars),
    }));
    const defaultId = botMsgs.defaultConfirmSavedReplyId || null;
    return res.json({ channel, options, defaultId });
  } catch (err) {
    log.error({ err }, "confirm-options failed");
    return res.status(500).json({ error: "Failed to load message options" });
  }
}

// ── GET /bookings/:id/confirm-preview?templateId=&savedReplyId= ───────────────
//
// Returns interpolated preview for a specific selection.
// If no id provided, returns the channel so the frontend can show options.

export async function confirmBookingPreview(req: Request, res: Response) {
  try {
    const hotelId     = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    const { templateId, savedReplyId } = req.query as { templateId?: string; savedReplyId?: string };

    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    const booking = await prisma.booking.findFirst({
      where:   { id: bookingId, hotelId },
      include: { guest: true, roomType: true, rooms: { include: { roomType: { select: { name: true } } } } },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const channel = await getGuestChannel(booking.guestId, hotelId);
    const vars    = buildVars(booking);

    if (templateId) {
      const template = await prisma.whatsAppTemplate.findFirst({
        where: { id: templateId, hotelId, status: "APPROVED" },
      });
      if (!template) return res.status(404).json({ error: "Template not found or not approved" });
      const comps    = template.components as any;
      const bodyText = comps?.body?.text ?? template.name;
      return res.json({ channel, messagePreview: interpolateTemplateBody(bodyText, vars), templateId });
    }

    if (savedReplyId) {
      const savedReply = await prisma.savedReply.findFirst({
        where: { id: savedReplyId, hotelId },
      });
      if (!savedReply) return res.status(404).json({ error: "Saved reply not found" });
      return res.json({ channel, messagePreview: interpolate(savedReply.body, vars), savedReplyId });
    }

    // No selection yet — return channel only so modal can drive the selection UI
    return res.json({ channel, messagePreview: null });
  } catch (err) {
    log.error({ err }, "confirm-preview failed");
    return res.status(500).json({ error: "Failed to generate preview" });
  }
}

// ── POST /bookings/:id/confirm ────────────────────────────────────────────────
//
// Body: { sendMessage: boolean, templateId?: string, savedReplyId?: string }
// Sets booking to CONFIRMED. If sendMessage=true, uses the explicitly provided
// templateId or savedReplyId — no hardcoded fallback lookup.

export async function confirmBooking(req: Request, res: Response) {
  try {
    const hotelId     = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    const { sendMessage, templateId, savedReplyId, variables } =
      req.body as { sendMessage?: boolean; templateId?: string; savedReplyId?: string; variables?: Record<string, string> };

    if (!bookingId) return res.status(400).json({ error: "bookingId required" });
    if (sendMessage && !templateId && !savedReplyId) {
      return res.status(400).json({ error: "templateId or savedReplyId required when sendMessage is true" });
    }
    if (sendMessage && templateId && variables) {
      const empty = Object.entries(variables).filter(([, v]) => !v.trim());
      if (empty.length > 0) {
        return res.status(400).json({
          error: `Template variable${empty.length > 1 ? "s" : ""} cannot be empty: ${empty.map(([k]) => k).join(", ")}`,
        });
      }
    }

    const booking = await prisma.booking.findFirst({
      where:   { id: bookingId, hotelId },
      include: { guest: true, roomType: true, rooms: { include: { roomType: { select: { name: true } } } } },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const result = await prisma.booking.updateMany({
      where: { id: bookingId, hotelId },
      data:  { status: BookingStatus.CONFIRMED },
    });
    if (result.count === 0) return res.status(404).json({ error: "Booking not found or unauthorized" });

    emitToHotel(hotelId, "booking:updated", { bookingId, status: BookingStatus.CONFIRMED });

    if (sendMessage) {
      // Extract only primitives before the IIFE — the Prisma booking object (with
      // joins) must not be captured in the closure or it stays pinned until the async
      // chain resolves (which may never happen if Meta API hangs).
      const guestId    = booking.guestId;
      const guestPhone = booking.guest!.phone;
      const sendVars   = buildVars(booking);

      // Resolve the saved-reply body synchronously here (before the IIFE) so we
      // don't carry a DB query and a Prisma result inside the closure either.
      let savedReplyText: string | null = null;
      if (savedReplyId) {
        const savedReply = await prisma.savedReply.findFirst({ where: { id: savedReplyId, hotelId } });
        if (!savedReply) return res.status(400).json({ error: "Saved reply not found" });
        savedReplyText = interpolate(savedReply.body, sendVars);
      }

      (async () => {
        try {
          const channel = await getGuestChannel(guestId, hotelId);

          if (templateId) {
            await sendTemplateMessage(hotelId, guestId, templateId, variables ?? sendVars);
          } else if (savedReplyText !== null) {
            const hotel = await prisma.hotel.findUnique({ where: { id: hotelId }, select: { phone: true } });
            await sendChannelMessage({
              channel,
              toPhone:   guestPhone,
              fromPhone: hotel?.phone ?? "",
              hotelId,
              guestId,
              text:      savedReplyText,
            });
          }
        } catch (sendErr) {
          log.warn({ err: sendErr, bookingId }, "confirm-send failed (non-fatal)");
        }
      })();
    }

    return res.json({ success: true });
  } catch (err) {
    log.error({ err }, "confirm booking failed");
    return res.status(500).json({ error: "Failed to confirm booking" });
  }
}

// ── GET /bookings/:id/confirmation-preview ────────────────────────────────────
//
// Resolves the configured Confirmation Sequence for this booking's channel + room
// type. If one exists, returns its hydrated steps as a checklist. If none is
// configured, returns the LEGACY single message (the hotel's default confirm
// template/saved-reply, else the first available) as a one-item checklist so the
// frontend renders both paths through the same modal.
//
// Response: { channel, source: "sequence" | "legacy", sequenceId?, steps: [
//   { stepId, refType, refId, title, body }
// ] }

export async function confirmationPreview(req: Request, res: Response) {
  try {
    const hotelId     = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    const booking = await prisma.booking.findFirst({
      where:   { id: bookingId, hotelId },
      include: { guest: true, roomType: true, rooms: { include: { roomType: { select: { name: true } } } } },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const channel    = await getGuestChannel(booking.guestId, hotelId);
    const roomTypeId = booking.roomTypeId ?? null;
    const vars       = buildVars(booking);

    // 1. Configured sequence?
    const sequence = await resolveConfirmationSequence(hotelId, channel, roomTypeId);
    if (sequence) {
      const steps = sequence.steps.map((s) => {
        const rawBody = s.body ?? "";
        // Only TEMPLATE steps carry fillable variables (Meta named/positional params).
        // Saved replies are interpolated server-side at send time, so no staff input.
        const variables = s.refType === "TEMPLATE" ? buildStepVariables(rawBody, vars) : [];
        return {
          stepId:  s.id,
          refType: s.refType,
          refId:   s.refId,
          title:   s.title ?? s.refId,
          body:    rawBody ? interpolateTemplateBody(rawBody, vars) : "",
          variables,
        };
      });
      return res.json({ channel, source: "sequence", sequenceId: sequence.id, steps });
    }

    // 2. Legacy fallback — single message rendered as a one-item checklist.
    const hotelCfg = await prisma.hotelConfig.findUnique({
      where:  { hotelId },
      select: { botMessages: true },
    });
    const botMsgs = (hotelCfg?.botMessages ?? {}) as Record<string, string>;

    if (channel === MessageChannel.WHATSAPP) {
      const defaultId = botMsgs.defaultConfirmTemplateId || null;
      const template =
        (defaultId
          ? await prisma.whatsAppTemplate.findFirst({ where: { id: defaultId, hotelId, status: "APPROVED" } })
          : null) ??
        (await prisma.whatsAppTemplate.findFirst({
          where: { hotelId, status: "APPROVED" }, orderBy: { name: "asc" },
        }));
      if (!template) return res.json({ channel, source: "legacy", steps: [] });
      const comps    = template.components as any;
      const bodyText = comps?.body?.text ?? template.name;
      return res.json({
        channel, source: "legacy",
        steps: [{
          stepId:    template.id,
          refType:   "TEMPLATE",
          refId:     template.id,
          title:     template.name,
          body:      interpolateTemplateBody(bodyText, vars),
          variables: buildStepVariables(bodyText, vars),
        }],
      });
    }

    // Instagram legacy — saved reply.
    const defaultId = botMsgs.defaultConfirmSavedReplyId || null;
    const reply =
      (defaultId
        ? await prisma.savedReply.findFirst({ where: { id: defaultId, hotelId } })
        : null) ??
      (await prisma.savedReply.findFirst({ where: { hotelId }, orderBy: { name: "asc" } }));
    if (!reply) return res.json({ channel, source: "legacy", steps: [] });
    return res.json({
      channel, source: "legacy",
      steps: [{
        stepId:  reply.id,
        refType: "SAVED_REPLY",
        refId:   reply.id,
        title:   reply.name,
        body:    interpolate(reply.body, vars),
      }],
    });
  } catch (err) {
    log.error({ err }, "confirmation-preview failed");
    return res.status(500).json({ error: "Failed to load confirmation preview" });
  }
}

// ── POST /bookings/:id/send-confirmation ──────────────────────────────────────
//
// Body: { steps: [{ stepId, refType, refId, skip }] }  (staff checklist, in order)
// Confirms the booking, then enqueues ONE confirmation-sequence job that sends the
// non-skipped steps sequentially. Returns a jobId immediately; per-step results are
// surfaced over Socket.IO ("confirmation:step" / "confirmation:done").

export async function sendConfirmation(req: Request, res: Response) {
  try {
    const hotelId     = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    const { steps: rawSteps } = req.body as {
      steps?: { stepId?: string; refType?: string; refId?: string; skip?: boolean; variables?: Record<string, unknown> }[];
    };

    if (!bookingId) return res.status(400).json({ error: "bookingId required" });
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      return res.status(400).json({ error: "steps must be a non-empty array" });
    }

    const steps: ConfirmationStepJob[] = [];
    for (const s of rawSteps) {
      if (s?.refType !== "TEMPLATE" && s?.refType !== "SAVED_REPLY") {
        return res.status(400).json({ error: `invalid step refType: ${s?.refType}` });
      }
      if (!s?.refId) return res.status(400).json({ error: "every step needs a refId" });

      const skip = Boolean(s.skip);
      const variables = (s.variables && typeof s.variables === "object")
        ? Object.fromEntries(Object.entries(s.variables).map(([k, v]) => [k, String(v ?? "")]))
        : undefined;

      // Block a TEMPLATE step that would send to Meta with an empty required value
      // (Meta rejects with #131008). Mirrors the legacy confirm flow's check. Skipped
      // steps aren't sent, so they're exempt.
      if (!skip && s.refType === "TEMPLATE" && variables) {
        const empty = Object.entries(variables).filter(([, v]) => !v.trim());
        if (empty.length > 0) {
          return res.status(400).json({
            error: `Template variable${empty.length > 1 ? "s" : ""} cannot be empty: ${empty.map(([k]) => k).join(", ")}`,
          });
        }
      }

      steps.push({
        stepId:  String(s.stepId ?? s.refId),
        refType: s.refType,
        refId:   String(s.refId),
        skip,
        ...(variables ? { variables } : {}),
      });
    }

    const booking = await prisma.booking.findFirst({
      where:   { id: bookingId, hotelId },
      include: { guest: true, roomType: true, rooms: { include: { roomType: { select: { name: true } } } } },
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!booking.guest?.phone) return res.status(400).json({ error: "Guest has no contact number" });

    // ── Double-submit guard ──────────────────────────────────────────────────
    // Deterministic job id per booking. If a send is already waiting/active/delayed
    // for this booking, reject rather than enqueue a second full sequence.
    const jobId = confirmationJobId(bookingId);
    const existing = await confirmationSequenceQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "waiting" || state === "active" || state === "delayed" || state === "waiting-children") {
        return res.status(409).json({
          error: "A confirmation is already being sent for this booking.",
          jobId,
        });
      }
      // A finished job (completed/failed) still occupies the id — remove it so the
      // staff can deliberately re-send (e.g. after a failed step).
      await existing.remove().catch(() => {});
    }

    const channel = await getGuestChannel(booking.guestId, hotelId);
    const vars    = buildVars(booking);
    const hotel   = await prisma.hotel.findUnique({ where: { id: hotelId }, select: { phone: true } });

    // Confirm the booking (idempotent) — mirrors the legacy /confirm behaviour.
    await prisma.booking.updateMany({
      where: { id: bookingId, hotelId },
      data:  { status: BookingStatus.CONFIRMED },
    });
    emitToHotel(hotelId, "booking:updated", { bookingId, status: BookingStatus.CONFIRMED });

    const jobData: ConfirmationSequenceJobData = {
      hotelId,
      bookingId,
      guestId:    booking.guestId,
      guestPhone: booking.guest.phone,
      fromPhone:  hotel?.phone ?? "",
      channel,
      vars,
      steps,
    };

    // jobId is deterministic so a racing duplicate add (same id) is a natural no-op.
    const job = await confirmationSequenceQueue.add("send", jobData, { jobId });

    return res.status(202).json({ jobId: job.id, stepCount: steps.filter((s) => !s.skip).length });
  } catch (err) {
    log.error({ err }, "send-confirmation failed");
    return res.status(500).json({ error: "Failed to start confirmation send" });
  }
}

// ── GET /bookings/:id/confirmation-status?jobId= ──────────────────────────────
//
// Returns the current per-step status of an in-flight or finished confirmation send
// by reading the BullMQ job's state + persisted progress + return value. The modal
// calls this on mount and on socket reconnect to recover any missed live events.
// Reads only the deterministic per-booking job (the optional jobId must match it).

export async function confirmationStatus(req: Request, res: Response) {
  try {
    const hotelId     = (req as any).user.hotelId as string;
    const { bookingId } = req.params;
    if (!bookingId) return res.status(400).json({ error: "bookingId required" });

    // Tenant check — booking must belong to this hotel.
    const booking = await prisma.booking.findFirst({ where: { id: bookingId, hotelId }, select: { id: true } });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const jobId = confirmationJobId(bookingId);
    const job   = await confirmationSequenceQueue.getJob(jobId);

    if (!job) {
      return res.json(reconstructStatus(jobId, null)); // state: "not_found"
    }

    const state = await job.getState();
    const snapshot = {
      state:       state ?? null,
      data:        (job.data ?? null) as any,
      progress:    (job.progress ?? null) as any,
      returnvalue: (job.returnvalue ?? null) as any,
    };
    return res.json(reconstructStatus(jobId, snapshot));
  } catch (err) {
    log.error({ err }, "confirmation-status failed");
    return res.status(500).json({ error: "Failed to load confirmation status" });
  }
}

export async function exportBookingsCsv(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;
    const { from, to } = req.query as { from?: string; to?: string };

    const fromDate = from ? new Date(from) : undefined;
    const toDate   = to   ? new Date(to)   : undefined;
    if (fromDate && isNaN(fromDate.getTime())) {
      return res.status(400).json({ error: "Invalid from date" });
    }
    if (toDate && isNaN(toDate.getTime())) {
      return res.status(400).json({ error: "Invalid to date" });
    }

    const where: any = { hotelId };
    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) where.createdAt.gte = fromDate;
      if (toDate)   where.createdAt.lte = toDate;
    }

    const bookings = await prisma.booking.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take:    10_000,
      include: { roomType: { select: { name: true } } },
    });

    const escape = (v: unknown) => {
      const s = String(v ?? "").replace(/"/g, '""');
      return `"${s}"`;
    };

    const headers = ["Reference","Guest Name","Room Type","Check-In","Check-Out","Nights","Price/Night","Advance Paid","Total","Status","Created"];
    const rows = bookings.map((b) => {
      const nights = Math.ceil((new Date(b.checkOut).getTime() - new Date(b.checkIn).getTime()) / 86_400_000);
      return [
        b.referenceNumber ?? b.id,
        b.guestName,
        b.roomType.name,
        b.checkIn.toISOString().slice(0, 10),
        b.checkOut.toISOString().slice(0, 10),
        nights,
        b.pricePerNight,
        b.advancePaid,
        b.totalPrice,
        b.status,
        b.createdAt.toISOString().slice(0, 10),
      ].map(escape).join(",");
    });

    const csv = [headers.join(","), ...rows].join("\r\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="bookings-${Date.now()}.csv"`);
    return res.send(csv);
  } catch (err) {
    log.error({ err }, "bookings CSV export failed");
    return res.status(500).json({ error: "Failed to export bookings" });
  }
}

export async function getBookingSummary(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user.hotelId;

    const [count, agg] = await Promise.all([
      prisma.booking.count({ where: { hotelId, status: BookingStatus.CONFIRMED } }),
      prisma.booking.aggregate({
        where: { hotelId, status: BookingStatus.CONFIRMED },
        _sum:  { totalPrice: true },
      }),
    ]);

    return res.json({
      totalBookings: count,
      totalRevenue:  Number(agg._sum.totalPrice ?? 0),
    });
  } catch (err) {
    log.error({ err }, "booking summary failed");
    return res.status(500).json({ error: "Failed to fetch summary" });
  }
}
