/**
 * Tests for the two new confirm-flow endpoints in booking.controller.ts:
 *   GET  /bookings/:id/confirmation-preview  (sequence + legacy fallback)
 *   POST /bookings/:id/send-confirmation     (validation, enqueue, skip passthrough)
 *
 * No supertest — handlers run directly with mocked req/res. Prisma, the queue,
 * resolveConfirmationSequence, send services and emit are all mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/connect", () => ({
  default: {
    booking:          { findFirst: vi.fn(), updateMany: vi.fn() },
    message:          { findFirst: vi.fn() },
    hotel:            { findUnique: vi.fn() },
    hotelConfig:      { findUnique: vi.fn() },
    whatsAppTemplate: { findFirst: vi.fn() },
    savedReply:       { findFirst: vi.fn() },
  },
}));
vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock("../realtime/emit", () => ({ emitToHotel: vi.fn() }));
vi.mock("../services/templates.service", () => ({ sendTemplateMessage: vi.fn() }));
vi.mock("../services/channel.send.service", () => ({ sendChannelMessage: vi.fn() }));
vi.mock("../services/confirmationSequence.service", () => ({ resolveConfirmationSequence: vi.fn() }));
// Default: no variable mappings → confirm-time resolution behaves exactly as before
// this feature (booking-field name match or blank). Part-4 resolution tests override.
vi.mock("../services/templateVariableMapping.service", () => ({ getTemplateMappings: vi.fn(async () => []) }));
vi.mock("../queue/confirmationSequence.queue", () => ({
  confirmationSequenceQueue: {
    add:    vi.fn(async () => ({ id: "confirm-b1" })),
    getJob: vi.fn(async () => null),  // default: no existing job
  },
}));

import prisma from "../db/connect";
import { emitToHotel } from "../realtime/emit";
import { resolveConfirmationSequence } from "../services/confirmationSequence.service";
import { getTemplateMappings } from "../services/templateVariableMapping.service";
import { confirmationSequenceQueue } from "../queue/confirmationSequence.queue";
import { confirmationPreview, sendConfirmation, confirmationStatus } from "./booking.controller";

const p = prisma as any;
const resolveSeq = resolveConfirmationSequence as ReturnType<typeof vi.fn>;
const getMappings = getTemplateMappings as ReturnType<typeof vi.fn>;
const queueAdd   = confirmationSequenceQueue.add as ReturnType<typeof vi.fn>;
const queueGetJob = confirmationSequenceQueue.getJob as ReturnType<typeof vi.fn>;

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json   = vi.fn((b: any) => { res.body = b; return res; });
  res.send   = vi.fn((b?: any) => { res.body = b; return res; });
  return res;
}
function req(over: any = {}) {
  return { user: { hotelId: "h1", role: "ADMIN" }, params: {}, body: {}, query: {}, ...over };
}

const bookingRow = {
  id: "b1", hotelId: "h1", guestId: "g1", roomTypeId: "rt1",
  guestName: "Sam", referenceNumber: "VKT-2026-00001",
  checkIn: new Date("2026-07-01"), checkOut: new Date("2026-07-03"),
  guest: { id: "g1", name: "Sam", phone: "+100" },
  roomType: { name: "Deluxe" }, rooms: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default channel resolution → WhatsApp (most recent message).
  p.message.findFirst.mockResolvedValue({ channel: "WHATSAPP" });
  p.hotel.findUnique.mockResolvedValue({ phone: "+200" });
  p.hotelConfig.findUnique.mockResolvedValue({ botMessages: {} });
  p.booking.updateMany.mockResolvedValue({ count: 1 });
  queueGetJob.mockResolvedValue(null);                       // no existing job by default
  queueAdd.mockResolvedValue({ id: "confirm-b1" });
  getMappings.mockResolvedValue([]);                         // no variable mappings by default
});

// ── confirmation-preview ─────────────────────────────────────────────────────────

describe("confirmationPreview", () => {
  it("404s for another hotel's booking", async () => {
    p.booking.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await confirmationPreview(req({ params: { bookingId: "b-other" } }) as any, res);
    expect(res.statusCode).toBe(404);
    expect(p.booking.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "b-other", hotelId: "h1" });
  });

  it("returns the configured sequence steps when one resolves", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    resolveSeq.mockResolvedValue({
      id: "seq1", channel: "WHATSAPP", name: "Std", isDefault: true, roomTypeScope: [],
      steps: [
        { id: "st0", order: 0, refType: "TEMPLATE",    refId: "tmpl1", title: "Confirmed", body: "Hi {{guestName}}" },
        { id: "st1", order: 1, refType: "SAVED_REPLY", refId: "sr1",   title: "Directions", body: "See you" },
      ],
    });
    const res = mockRes();
    await confirmationPreview(req({ params: { bookingId: "b1" } }) as any, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe("sequence");
    expect(res.body.sequenceId).toBe("seq1");
    expect(res.body.steps).toHaveLength(2);
    // body interpolated with booking vars
    expect(res.body.steps[0]).toMatchObject({ stepId: "st0", refType: "TEMPLATE", title: "Confirmed", body: "Hi Sam" });
  });

  it("exposes template variables with auto-derived defaults; saved-reply steps carry none", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    resolveSeq.mockResolvedValue({
      id: "seq1", channel: "WHATSAPP", name: "Std", isDefault: true, roomTypeScope: [],
      steps: [
        // guestName auto-derives (Sam); checkInTime is NOT in buildVars → empty default.
        { id: "st0", order: 0, refType: "TEMPLATE",    refId: "tmpl1", title: "Confirmed",
          body: "Hi {{guestName}}, check-in {{checkInTime}}" },
        { id: "st1", order: 1, refType: "SAVED_REPLY", refId: "sr1", title: "Directions", body: "See you" },
      ],
    });
    const res = mockRes();
    await confirmationPreview(req({ params: { bookingId: "b1" } }) as any, res);

    expect(res.body.steps[0].variables).toEqual([
      { name: "guestName",   defaultValue: "Sam" },
      { name: "checkInTime", defaultValue: "" },
    ]);
    // Saved-reply step has no fillable variables.
    expect(res.body.steps[1].variables).toEqual([]);
  });

  it("a template with no variables yields an empty variables array (no spurious form)", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    resolveSeq.mockResolvedValue({
      id: "seq1", channel: "WHATSAPP", name: "Std", isDefault: true, roomTypeScope: [],
      steps: [{ id: "st0", order: 0, refType: "TEMPLATE", refId: "tmpl1", title: "Static", body: "Welcome aboard!" }],
    });
    const res = mockRes();
    await confirmationPreview(req({ params: { bookingId: "b1" } }) as any, res);
    expect(res.body.steps[0].variables).toEqual([]);
  });

  // ── Variable-mapping resolution (Part 4) ──────────────────────────────────────
  // A single-template sequence with one {{arrival}} variable, varied per test.
  function seqWithArrival() {
    resolveSeq.mockResolvedValue({
      id: "seq1", channel: "WHATSAPP", name: "Std", isDefault: true, roomTypeScope: [],
      steps: [{ id: "st0", order: 0, refType: "TEMPLATE", refId: "tmpl1", title: "T", body: "Arrive {{arrival}}" }],
    });
  }

  it("BOOKING_FIELD mapping resolves the default via the mapped booking field", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    seqWithArrival();
    // {{arrival}} → BOOKING_FIELD guestName → "Sam"
    getMappings.mockResolvedValue([{ variableName: "arrival", sourceType: "BOOKING_FIELD", sourceKey: "guestName" }]);
    const res = mockRes();
    await confirmationPreview(req({ params: { bookingId: "b1" } }) as any, res);
    expect(res.body.steps[0].variables).toEqual([{ name: "arrival", defaultValue: "Sam" }]);
  });

  it("FLOW_VAR mapping resolves from booking.flowVars when present", async () => {
    p.booking.findFirst.mockResolvedValue({ ...bookingRow, flowVars: { arrivalTime: "2 PM" } });
    seqWithArrival();
    getMappings.mockResolvedValue([{ variableName: "arrival", sourceType: "FLOW_VAR", sourceKey: "arrivalTime" }]);
    const res = mockRes();
    await confirmationPreview(req({ params: { bookingId: "b1" } }) as any, res);
    expect(res.body.steps[0].variables).toEqual([{ name: "arrival", defaultValue: "2 PM" }]);
  });

  it("FLOW_VAR mapping with no snapshot value falls through to blank (manual input)", async () => {
    p.booking.findFirst.mockResolvedValue({ ...bookingRow, flowVars: null });   // no snapshot
    seqWithArrival();
    getMappings.mockResolvedValue([{ variableName: "arrival", sourceType: "FLOW_VAR", sourceKey: "arrivalTime" }]);
    const res = mockRes();
    await confirmationPreview(req({ params: { bookingId: "b1" } }) as any, res);
    expect(res.body.steps[0].variables).toEqual([{ name: "arrival", defaultValue: "" }]);
  });

  it("no mapping row → unchanged behavior (booking-field name match or blank)", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    // body references guestName (matches buildVars) + arrival (no match, no mapping)
    resolveSeq.mockResolvedValue({
      id: "seq1", channel: "WHATSAPP", name: "Std", isDefault: true, roomTypeScope: [],
      steps: [{ id: "st0", order: 0, refType: "TEMPLATE", refId: "tmpl1", title: "T", body: "Hi {{guestName}} {{arrival}}" }],
    });
    getMappings.mockResolvedValue([]);   // no mappings
    const res = mockRes();
    await confirmationPreview(req({ params: { bookingId: "b1" } }) as any, res);
    expect(res.body.steps[0].variables).toEqual([
      { name: "guestName", defaultValue: "Sam" },  // name match via buildVars
      { name: "arrival",   defaultValue: "" },      // no match, no mapping → blank
    ]);
  });

  it("falls back to the legacy default template as a one-item checklist (no sequence)", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    resolveSeq.mockResolvedValue(null);
    p.hotelConfig.findUnique.mockResolvedValue({ botMessages: { defaultConfirmTemplateId: "tmplDef" } });
    p.whatsAppTemplate.findFirst.mockResolvedValue({
      id: "tmplDef", name: "Default Confirm", status: "APPROVED", components: { body: { text: "Hello {{guestName}}" } },
    });

    const res = mockRes();
    await confirmationPreview(req({ params: { bookingId: "b1" } }) as any, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe("legacy");
    expect(res.body.steps).toHaveLength(1);
    expect(res.body.steps[0]).toMatchObject({ refType: "TEMPLATE", refId: "tmplDef", body: "Hello Sam" });
  });

  it("legacy fallback returns empty steps when the hotel has no template", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    resolveSeq.mockResolvedValue(null);
    p.whatsAppTemplate.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await confirmationPreview(req({ params: { bookingId: "b1" } }) as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ source: "legacy", steps: [] });
  });

  it("uses Instagram saved-reply legacy fallback for an Instagram booking", async () => {
    p.message.findFirst.mockResolvedValue({ channel: "INSTAGRAM" });
    p.booking.findFirst.mockResolvedValue(bookingRow);
    resolveSeq.mockResolvedValue(null);
    p.savedReply.findFirst.mockResolvedValue({ id: "sr9", name: "IG Confirm", body: "Hi {{guestName}}" });
    const res = mockRes();
    await confirmationPreview(req({ params: { bookingId: "b1" } }) as any, res);
    expect(res.body.steps[0]).toMatchObject({ refType: "SAVED_REPLY", refId: "sr9", body: "Hi Sam" });
  });
});

// ── send-confirmation ────────────────────────────────────────────────────────────

describe("sendConfirmation", () => {
  const steps = [
    { stepId: "st0", refType: "TEMPLATE",    refId: "tmpl1", skip: false },
    { stepId: "st1", refType: "SAVED_REPLY", refId: "sr1",   skip: true  },
  ];

  it("400s when steps is empty", async () => {
    const res = mockRes();
    await sendConfirmation(req({ params: { bookingId: "b1" }, body: { steps: [] } }) as any, res);
    expect(res.statusCode).toBe(400);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("400s on an invalid step refType", async () => {
    const res = mockRes();
    await sendConfirmation(req({
      params: { bookingId: "b1" },
      body: { steps: [{ stepId: "x", refType: "BOGUS", refId: "z" }] },
    }) as any, res);
    expect(res.statusCode).toBe(400);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("404s for another hotel's booking", async () => {
    p.booking.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await sendConfirmation(req({ params: { bookingId: "b-other" }, body: { steps } }) as any, res);
    expect(res.statusCode).toBe(404);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("confirms the booking, enqueues a job, and returns 202 + jobId (skip flags preserved)", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    const res = mockRes();
    await sendConfirmation(req({ params: { bookingId: "b1" }, body: { steps } }) as any, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ jobId: "confirm-b1", stepCount: 1 }); // 1 non-skipped

    // Booking confirmed + event emitted.
    expect(p.booking.updateMany).toHaveBeenCalledWith({
      where: { id: "b1", hotelId: "h1" }, data: { status: "CONFIRMED" },
    });
    expect(emitToHotel).toHaveBeenCalledWith("h1", "booking:updated", { bookingId: "b1", status: "CONFIRMED" });

    // Job carries the steps verbatim (skip flag passed through to the worker)
    // and uses the deterministic per-booking job id for dedupe.
    const [, jobData, opts] = queueAdd.mock.calls[0]!;
    expect(jobData).toMatchObject({ hotelId: "h1", bookingId: "b1", guestId: "g1", channel: "WHATSAPP" });
    expect(jobData.steps).toEqual([
      { stepId: "st0", refType: "TEMPLATE",    refId: "tmpl1", skip: false },
      { stepId: "st1", refType: "SAVED_REPLY", refId: "sr1",   skip: true  },
    ]);
    expect(opts).toEqual({ jobId: "confirm-b1" });
  });

  it("passes per-step template variables through to the job", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    const res = mockRes();
    await sendConfirmation(req({
      params: { bookingId: "b1" },
      body: { steps: [
        { stepId: "st0", refType: "TEMPLATE", refId: "tmpl1", skip: false,
          variables: { guestName: "Samuel", checkInTime: "2 PM" } },
      ] },
    }) as any, res);

    expect(res.statusCode).toBe(202);
    const [, jobData] = queueAdd.mock.calls[0]!;
    expect(jobData.steps[0]).toEqual({
      stepId: "st0", refType: "TEMPLATE", refId: "tmpl1", skip: false,
      variables: { guestName: "Samuel", checkInTime: "2 PM" },
    });
  });

  it("400s when a non-skipped TEMPLATE step has an empty required variable (blocks #131008)", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    const res = mockRes();
    await sendConfirmation(req({
      params: { bookingId: "b1" },
      body: { steps: [
        { stepId: "st0", refType: "TEMPLATE", refId: "tmpl1", skip: false,
          variables: { guestName: "Sam", checkInTime: "  " } }, // blank
      ] },
    }) as any, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/cannot be empty: checkInTime/i);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("does NOT block an empty variable on a SKIPPED template step (not sent)", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    const res = mockRes();
    await sendConfirmation(req({
      params: { bookingId: "b1" },
      body: { steps: [
        { stepId: "st0", refType: "TEMPLATE",    refId: "tmpl1", skip: true,
          variables: { checkInTime: "" } },              // skipped → exempt
        { stepId: "st1", refType: "SAVED_REPLY", refId: "sr1", skip: false },
      ] },
    }) as any, res);

    expect(res.statusCode).toBe(202);
    expect(queueAdd).toHaveBeenCalled();
  });

  it("400s when the guest has no phone number", async () => {
    p.booking.findFirst.mockResolvedValue({ ...bookingRow, guest: { id: "g1", name: "Sam", phone: "" } });
    const res = mockRes();
    await sendConfirmation(req({ params: { bookingId: "b1" }, body: { steps } }) as any, res);
    expect(res.statusCode).toBe(400);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  // ── Double-submit guard ──────────────────────────────────────────────────────

  it("409s when a send is already in flight (active job) and does NOT enqueue again", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    queueGetJob.mockResolvedValue({ getState: vi.fn(async () => "active"), remove: vi.fn() });

    const res = mockRes();
    await sendConfirmation(req({ params: { bookingId: "b1" }, body: { steps } }) as any, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already being sent/i);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("409s when a job is waiting", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    queueGetJob.mockResolvedValue({ getState: vi.fn(async () => "waiting"), remove: vi.fn() });
    const res = mockRes();
    await sendConfirmation(req({ params: { bookingId: "b1" }, body: { steps } }) as any, res);
    expect(res.statusCode).toBe(409);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("removes a finished job and allows a deliberate re-send", async () => {
    p.booking.findFirst.mockResolvedValue(bookingRow);
    const remove = vi.fn(async () => {});
    queueGetJob.mockResolvedValue({ getState: vi.fn(async () => "completed"), remove });

    const res = mockRes();
    await sendConfirmation(req({ params: { bookingId: "b1" }, body: { steps } }) as any, res);

    expect(remove).toHaveBeenCalled();          // stale finished job cleared
    expect(res.statusCode).toBe(202);           // re-send proceeds
    expect(queueAdd).toHaveBeenCalled();
  });
});

// ── confirmation-status ──────────────────────────────────────────────────────────

describe("confirmationStatus", () => {
  it("404s for another hotel's booking", async () => {
    p.booking.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await confirmationStatus(req({ params: { bookingId: "b-other" } }) as any, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns not_found when no job exists for the booking", async () => {
    p.booking.findFirst.mockResolvedValue({ id: "b1" });
    queueGetJob.mockResolvedValue(null);
    const res = mockRes();
    await confirmationStatus(req({ params: { bookingId: "b1" } }) as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ state: "not_found", steps: [] });
  });

  it("reconstructs per-step status from the job's persisted progress", async () => {
    p.booking.findFirst.mockResolvedValue({ id: "b1" });
    queueGetJob.mockResolvedValue({
      getState: vi.fn(async () => "active"),
      data:     { steps: [{ stepId: "s0", refType: "TEMPLATE", refId: "t1", skip: false }] },
      progress: { steps: [{ stepId: "s0", index: 0, refType: "TEMPLATE", refId: "t1", status: "sent" }] },
      returnvalue: null,
    });
    const res = mockRes();
    await confirmationStatus(req({ params: { bookingId: "b1" } }) as any, res);
    expect(res.body.state).toBe("active");
    expect(res.body.inFlight).toBe(true);
    expect(res.body.steps[0]).toMatchObject({ stepId: "s0", status: "sent" });
  });
});
