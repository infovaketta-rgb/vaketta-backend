/**
 * Tests for confirmationSequence.service.ts.
 *   validateSequenceSteps — pure, no DB.
 *   resolveConfirmationSequence — mocks prisma to assert the room-type → default →
 *     null priority chain, step ordering, and title/body hydration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/connect", () => ({
  default: {
    confirmationSequence: { findFirst: vi.fn() },
    whatsAppTemplate:     { findMany:  vi.fn() },
    savedReply:           { findMany:  vi.fn() },
  },
}));

import prisma from "../db/connect";
import {
  validateSequenceSteps,
  resolveConfirmationSequence,
  MAX_SEQUENCE_STEPS,
} from "./confirmationSequence.service";

const findFirst = prisma.confirmationSequence.findFirst as ReturnType<typeof vi.fn>;
const tmplFind  = prisma.whatsAppTemplate.findMany     as ReturnType<typeof vi.fn>;
const srFind    = prisma.savedReply.findMany           as ReturnType<typeof vi.fn>;

// ── validateSequenceSteps ────────────────────────────────────────────────────────

describe("validateSequenceSteps", () => {
  it("accepts an all-template WhatsApp sequence", () => {
    const r = validateSequenceSteps(
      [
        { refType: "TEMPLATE", order: 0 },
        { refType: "TEMPLATE", order: 1 },
      ],
      "WHATSAPP"
    );
    expect(r.valid).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("accepts a template-then-saved-reply WhatsApp sequence", () => {
    const r = validateSequenceSteps(
      [
        { refType: "TEMPLATE",     order: 0 },
        { refType: "SAVED_REPLY",  order: 1 },
        { refType: "SAVED_REPLY",  order: 2 },
      ],
      "WHATSAPP"
    );
    expect(r.valid).toBe(true);
  });

  it("evaluates by `order`, not array position", () => {
    // SAVED_REPLY listed first in the array but actually delivered after the template.
    const r = validateSequenceSteps(
      [
        { refType: "SAVED_REPLY", order: 1 },
        { refType: "TEMPLATE",    order: 0 },
      ],
      "WHATSAPP"
    );
    expect(r.valid).toBe(true);
  });

  it("rejects a saved-reply-first WhatsApp sequence", () => {
    const r = validateSequenceSteps(
      [
        { refType: "SAVED_REPLY", order: 0 },
        { refType: "TEMPLATE",    order: 1 },
      ],
      "WHATSAPP"
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/first step.*must be a template/i);
  });

  it("rejects an Instagram sequence that contains a template", () => {
    const r = validateSequenceSteps(
      [
        { refType: "SAVED_REPLY", order: 0 },
        { refType: "TEMPLATE",    order: 1 },
      ],
      "INSTAGRAM"
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/instagram.*cannot use templates/i);
  });

  it("accepts an all-saved-reply Instagram sequence", () => {
    const r = validateSequenceSteps(
      [
        { refType: "SAVED_REPLY", order: 0 },
        { refType: "SAVED_REPLY", order: 1 },
      ],
      "INSTAGRAM"
    );
    expect(r.valid).toBe(true);
  });

  it("rejects an 11-step sequence (exceeds the hard cap)", () => {
    const steps = Array.from({ length: MAX_SEQUENCE_STEPS + 1 }, (_, i) => ({
      refType: "TEMPLATE",
      order:   i,
    }));
    const r = validateSequenceSteps(steps, "WHATSAPP");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/at most 10 steps/i);
  });

  it("rejects an empty sequence", () => {
    const r = validateSequenceSteps([], "WHATSAPP");
    expect(r.valid).toBe(false);
  });
});

// ── resolveConfirmationSequence ──────────────────────────────────────────────────

describe("resolveConfirmationSequence", () => {
  beforeEach(() => {
    findFirst.mockReset();
    tmplFind.mockReset();
    srFind.mockReset();
    tmplFind.mockResolvedValue([]);
    srFind.mockResolvedValue([]);
  });

  function seq(over: Partial<any> = {}) {
    return {
      id: "seq1", hotelId: "h1", channel: "WHATSAPP",
      name: "Default", isDefault: false, roomTypeScope: ["rt_deluxe"],
      steps: [
        { id: "st1", order: 0, refType: "TEMPLATE",    refId: "tmpl1" },
        { id: "st2", order: 1, refType: "SAVED_REPLY", refId: "sr1" },
      ],
      ...over,
    };
  }

  it("returns the room-type-specific match when one exists", async () => {
    findFirst.mockResolvedValueOnce(seq());
    tmplFind.mockResolvedValue([
      { id: "tmpl1", name: "Booking Confirmed", components: { body: { text: "Hi {{1}}" } } },
    ]);
    srFind.mockResolvedValue([{ id: "sr1", name: "Directions", body: "Here is how to reach us." }]);

    const result = await resolveConfirmationSequence("h1", "WHATSAPP", "rt_deluxe");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("seq1");
    // First query is the room-type-scoped one — `has` filter present.
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      hotelId: "h1", channel: "WHATSAPP", roomTypeScope: { has: "rt_deluxe" },
    });
    // Hydrated content for preview.
    expect(result!.steps[0]).toMatchObject({ refType: "TEMPLATE", title: "Booking Confirmed", body: "Hi {{1}}" });
    expect(result!.steps[1]).toMatchObject({ refType: "SAVED_REPLY", title: "Directions", body: "Here is how to reach us." });
  });

  it("falls back to the default sequence when no room-type match", async () => {
    // 1st call (room-type scoped) → no match; 2nd call (isDefault) → match.
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(seq({ id: "seqDefault", isDefault: true, roomTypeScope: [] }));
    tmplFind.mockResolvedValue([
      { id: "tmpl1", name: "Confirmed", components: { body: { text: "Body" } } },
    ]);
    srFind.mockResolvedValue([{ id: "sr1", name: "SR", body: "sr body" }]);

    const result = await resolveConfirmationSequence("h1", "WHATSAPP", "rt_unknown");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("seqDefault");
    expect(result!.isDefault).toBe(true);
    // Second query targets isDefault.
    expect(findFirst.mock.calls[1]![0].where).toMatchObject({
      hotelId: "h1", channel: "WHATSAPP", isDefault: true,
    });
  });

  it("queries the default directly (no room-type query) when roomTypeId is null", async () => {
    findFirst.mockResolvedValueOnce(seq({ id: "seqDefault", isDefault: true, roomTypeScope: [] }));
    tmplFind.mockResolvedValue([
      { id: "tmpl1", name: "T", components: { body: { text: "b" } } },
    ]);
    srFind.mockResolvedValue([{ id: "sr1", name: "S", body: "b" }]);

    const result = await resolveConfirmationSequence("h1", "WHATSAPP", null);

    expect(result!.id).toBe("seqDefault");
    // Only one findFirst call, and it's the isDefault query.
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({ isDefault: true });
  });

  it("returns null when nothing is configured", async () => {
    findFirst.mockResolvedValue(null);
    const result = await resolveConfirmationSequence("h1", "WHATSAPP", "rt_deluxe");
    expect(result).toBeNull();
    expect(tmplFind).not.toHaveBeenCalled();
    expect(srFind).not.toHaveBeenCalled();
  });

  it("returns steps ordered by `order` ascending with correct hydration", async () => {
    findFirst.mockResolvedValueOnce(
      seq({
        steps: [
          { id: "st0", order: 0, refType: "TEMPLATE",    refId: "tmpl1" },
          { id: "st1", order: 1, refType: "SAVED_REPLY", refId: "sr1" },
          { id: "st2", order: 2, refType: "SAVED_REPLY", refId: "sr2" },
        ],
      })
    );
    tmplFind.mockResolvedValue([
      { id: "tmpl1", name: "Welcome", components: { body: { text: "Welcome body" } } },
    ]);
    srFind.mockResolvedValue([
      { id: "sr1", name: "Reply One", body: "one" },
      { id: "sr2", name: "Reply Two", body: "two" },
    ]);

    const result = await resolveConfirmationSequence("h1", "WHATSAPP", "rt_deluxe");

    expect(result!.steps.map((s) => s.order)).toEqual([0, 1, 2]);
    expect(result!.steps.map((s) => s.refId)).toEqual(["tmpl1", "sr1", "sr2"]);
    expect(result!.steps.map((s) => s.title)).toEqual(["Welcome", "Reply One", "Reply Two"]);
  });

  it("hydrates title/body to null when a referenced ref is missing", async () => {
    findFirst.mockResolvedValueOnce(
      seq({ steps: [{ id: "st0", order: 0, refType: "TEMPLATE", refId: "gone" }] })
    );
    tmplFind.mockResolvedValue([]); // ref no longer exists
    const result = await resolveConfirmationSequence("h1", "WHATSAPP", "rt_deluxe");
    expect(result!.steps[0]).toMatchObject({ refId: "gone", title: null, body: null });
  });
});
