/**
 * Tests for confirmationSequence.controller.ts.
 *
 * No supertest in this project — handlers are exercised directly with mocked
 * req/res and a mocked prisma client (matching the established unit-test style).
 * Covers: create/update/delete happy paths, validation rejection, cross-hotel
 * access rejection, and default-uniqueness-per-channel enforcement.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// `tx` passed to $transaction reuses the same mocked model methods.
const txClient = {
  confirmationSequence:     { updateMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  confirmationSequenceStep: { deleteMany: vi.fn() },
};

vi.mock("../db/connect", () => ({
  default: {
    confirmationSequence: {
      findMany:   vi.fn(),
      findFirst:  vi.fn(),
      create:     vi.fn(),
      update:     vi.fn(),
      delete:     vi.fn(),
      updateMany: vi.fn(),
    },
    confirmationSequenceStep: { deleteMany: vi.fn() },
    whatsAppTemplate: { findMany: vi.fn() },
    savedReply:       { findMany: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(txClient)),
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

import prisma from "../db/connect";
import {
  listConfirmationSequences,
  createConfirmationSequence,
  updateConfirmationSequence,
  deleteConfirmationSequence,
} from "./confirmationSequence.controller";

const p = prisma as any;

function mockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json   = vi.fn((b: any) => { res.body = b; return res; });
  res.send   = vi.fn((b?: any) => { res.body = b; return res; });
  return res;
}

function req(over: any = {}) {
  return {
    user:   { hotelId: "h1", role: "ADMIN" },
    query:  {},
    params: {},
    body:   {},
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: all refs belong to the hotel (ref-ownership check passes).
  p.whatsAppTemplate.findMany.mockResolvedValue([{ id: "tmpl1" }, { id: "tmpl2" }]);
  p.savedReply.findMany.mockResolvedValue([{ id: "sr1" }, { id: "sr2" }]);
  txClient.confirmationSequence.updateMany.mockResolvedValue({ count: 0 });
  txClient.confirmationSequenceStep.deleteMany.mockResolvedValue({ count: 0 });
});

// ── LIST ─────────────────────────────────────────────────────────────────────────

describe("listConfirmationSequences", () => {
  it("400s on a missing/invalid channel", async () => {
    const res = mockRes();
    await listConfirmationSequences(req({ query: {} }) as any, res);
    expect(res.statusCode).toBe(400);
  });

  it("lists sequences scoped to the JWT hotelId with hydrated steps", async () => {
    p.confirmationSequence.findMany.mockResolvedValue([
      {
        id: "seq1", hotelId: "h1", channel: "WHATSAPP", name: "Default",
        isDefault: true, roomTypeScope: [],
        steps: [{ id: "st1", order: 0, refType: "TEMPLATE", refId: "tmpl1" }],
      },
    ]);
    p.whatsAppTemplate.findMany.mockResolvedValue([
      { id: "tmpl1", name: "Confirmed", components: { body: { text: "Hi" } } },
    ]);

    const res = mockRes();
    await listConfirmationSequences(req({ query: { channel: "WHATSAPP" } }) as any, res);

    expect(res.statusCode).toBe(200);
    expect(p.confirmationSequence.findMany.mock.calls[0][0].where).toMatchObject({
      hotelId: "h1", channel: "WHATSAPP",
    });
    expect(res.body[0].steps[0]).toMatchObject({ title: "Confirmed", body: "Hi" });
  });
});

// ── CREATE ─────────────────────────────────────────────────────────────────────

describe("createConfirmationSequence", () => {
  const goodBody = {
    channel: "WHATSAPP", name: "Welcome", isDefault: false, roomTypeScope: [],
    steps: [
      { order: 0, refType: "TEMPLATE",    refId: "tmpl1" },
      { order: 1, refType: "SAVED_REPLY", refId: "sr1" },
    ],
  };

  it("creates a valid sequence (201)", async () => {
    txClient.confirmationSequence.create.mockResolvedValue({
      id: "new1", hotelId: "h1", channel: "WHATSAPP", name: "Welcome",
      isDefault: false, roomTypeScope: [],
      steps: [
        { id: "s0", order: 0, refType: "TEMPLATE",    refId: "tmpl1" },
        { id: "s1", order: 1, refType: "SAVED_REPLY", refId: "sr1" },
      ],
    });
    p.whatsAppTemplate.findMany.mockResolvedValue([{ id: "tmpl1", name: "T", components: { body: { text: "b" } } }]);
    p.savedReply.findMany.mockResolvedValue([{ id: "sr1", name: "S", body: "b" }]);

    const res = mockRes();
    await createConfirmationSequence(req({ body: goodBody }) as any, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBe("new1");
    // hotelId came from JWT, not the body.
    expect(txClient.confirmationSequence.create.mock.calls[0]![0].data.hotelId).toBe("h1");
  });

  it("rejects a saved-reply-first WhatsApp sequence (400 with validation error)", async () => {
    const res = mockRes();
    await createConfirmationSequence(req({
      body: { ...goodBody, steps: [
        { order: 0, refType: "SAVED_REPLY", refId: "sr1" },
        { order: 1, refType: "TEMPLATE",    refId: "tmpl1" },
      ] },
    }) as any, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/first step.*must be a template/i);
    expect(txClient.confirmationSequence.create).not.toHaveBeenCalled();
  });

  it("rejects a step that references another hotel's ref (400)", async () => {
    // The template id is not returned by the hotel-scoped lookup → not owned.
    p.whatsAppTemplate.findMany.mockResolvedValue([]);
    const res = mockRes();
    await createConfirmationSequence(req({ body: goodBody }) as any, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/template not found/i);
    expect(txClient.confirmationSequence.create).not.toHaveBeenCalled();
  });

  it("unsets other defaults when creating with isDefault=true", async () => {
    txClient.confirmationSequence.create.mockResolvedValue({
      id: "new1", hotelId: "h1", channel: "WHATSAPP", name: "Welcome",
      isDefault: true, roomTypeScope: [], steps: [],
    });
    const res = mockRes();
    await createConfirmationSequence(req({ body: { ...goodBody, isDefault: true } }) as any, res);

    expect(txClient.confirmationSequence.updateMany).toHaveBeenCalledWith({
      where: { hotelId: "h1", channel: "WHATSAPP", isDefault: true },
      data:  { isDefault: false },
    });
  });

  it("does not clear defaults when isDefault is false", async () => {
    txClient.confirmationSequence.create.mockResolvedValue({
      id: "new1", hotelId: "h1", channel: "WHATSAPP", name: "Welcome",
      isDefault: false, roomTypeScope: [], steps: [],
    });
    const res = mockRes();
    await createConfirmationSequence(req({ body: goodBody }) as any, res);
    expect(txClient.confirmationSequence.updateMany).not.toHaveBeenCalled();
  });
});

// ── UPDATE ─────────────────────────────────────────────────────────────────────

describe("updateConfirmationSequence", () => {
  const existing = {
    id: "seq1", hotelId: "h1", channel: "WHATSAPP", name: "Old",
    isDefault: false, roomTypeScope: [],
  };
  const goodSteps = [
    { order: 0, refType: "TEMPLATE",    refId: "tmpl1" },
    { order: 1, refType: "SAVED_REPLY", refId: "sr1" },
  ];

  it("404s when the sequence belongs to another hotel", async () => {
    // findFirst scoped to {id, hotelId} returns nothing for a foreign sequence.
    p.confirmationSequence.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await updateConfirmationSequence(req({
      params: { id: "seq-other" }, body: { steps: goodSteps },
    }) as any, res);
    expect(res.statusCode).toBe(404);
    expect(p.confirmationSequence.findFirst.mock.calls[0][0].where).toMatchObject({
      id: "seq-other", hotelId: "h1",
    });
  });

  it("replaces steps entirely (deleteMany then recreate) inside the transaction", async () => {
    p.confirmationSequence.findFirst.mockResolvedValue(existing);
    txClient.confirmationSequence.update.mockResolvedValue({
      ...existing, name: "New",
      steps: [
        { id: "s0", order: 0, refType: "TEMPLATE",    refId: "tmpl1" },
        { id: "s1", order: 1, refType: "SAVED_REPLY", refId: "sr1" },
      ],
    });
    p.whatsAppTemplate.findMany.mockResolvedValue([{ id: "tmpl1", name: "T", components: { body: { text: "b" } } }]);
    p.savedReply.findMany.mockResolvedValue([{ id: "sr1", name: "S", body: "b" }]);

    const res = mockRes();
    await updateConfirmationSequence(req({
      params: { id: "seq1" }, body: { name: "New", steps: goodSteps },
    }) as any, res);

    expect(res.statusCode).toBe(200);
    expect(txClient.confirmationSequenceStep.deleteMany).toHaveBeenCalledWith({ where: { sequenceId: "seq1" } });
    expect(res.body.name).toBe("New");
  });

  it("re-runs validation against the immutable channel and rejects bad steps", async () => {
    p.confirmationSequence.findFirst.mockResolvedValue(existing); // WHATSAPP
    const res = mockRes();
    await updateConfirmationSequence(req({
      params: { id: "seq1" },
      body: { steps: [{ order: 0, refType: "SAVED_REPLY", refId: "sr1" }] },
    }) as any, res);
    expect(res.statusCode).toBe(400);
    expect(txClient.confirmationSequence.update).not.toHaveBeenCalled();
  });

  it("unsets sibling defaults (excluding self) when setting isDefault=true", async () => {
    p.confirmationSequence.findFirst.mockResolvedValue(existing);
    txClient.confirmationSequence.update.mockResolvedValue({ ...existing, isDefault: true, steps: [] });
    const res = mockRes();
    await updateConfirmationSequence(req({
      params: { id: "seq1" }, body: { isDefault: true, steps: goodSteps },
    }) as any, res);

    expect(txClient.confirmationSequence.updateMany).toHaveBeenCalledWith({
      where: { hotelId: "h1", channel: "WHATSAPP", isDefault: true, id: { not: "seq1" } },
      data:  { isDefault: false },
    });
  });
});

// ── DELETE ─────────────────────────────────────────────────────────────────────

describe("deleteConfirmationSequence", () => {
  it("404s for another hotel's sequence (cross-hotel rejection)", async () => {
    p.confirmationSequence.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await deleteConfirmationSequence(req({ params: { id: "seq-other" } }) as any, res);
    expect(res.statusCode).toBe(404);
    expect(p.confirmationSequence.delete).not.toHaveBeenCalled();
    expect(p.confirmationSequence.findFirst.mock.calls[0][0].where).toMatchObject({
      id: "seq-other", hotelId: "h1",
    });
  });

  it("deletes an owned sequence (204)", async () => {
    p.confirmationSequence.findFirst.mockResolvedValue({ id: "seq1", hotelId: "h1" });
    p.confirmationSequence.delete.mockResolvedValue({});
    const res = mockRes();
    await deleteConfirmationSequence(req({ params: { id: "seq1" } }) as any, res);
    expect(res.statusCode).toBe(204);
    expect(p.confirmationSequence.delete).toHaveBeenCalledWith({ where: { id: "seq1" } });
  });
});
