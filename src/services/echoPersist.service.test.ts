/**
 * Regression tests for persistEchoedOutboundMessage — the shared persister for
 * echoed outbound messages (WhatsApp smb_message_echoes + Instagram is_echo).
 *
 * Locks in: OUT direction + SENT status, DB-level dedup on (hotelId, wamid) with
 * update: {} (never overwrites), and message:new emitted ONLY when the call
 * actually created the row — duplicate mids are ignored silently.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const guestUpsert = vi.fn();

// In-memory (hotelId, wamid) store so upsert/findUnique exercise the same
// create-vs-no-op semantics the DB unique constraint guarantees.
let messageStore: Map<string, any>;
let seq = 0;
const keyFor = (hotelId: string, wamid: string) => `${hotelId}::${wamid}`;

const messageFindUnique = vi.fn(async (args: any) => {
  const { hotelId, wamid } = args.where.hotelId_wamid;
  const existing = messageStore.get(keyFor(hotelId, wamid));
  return existing ? { id: existing.id } : null;
});
const messageUpsert = vi.fn(async (args: any) => {
  const { hotelId, wamid } = args.where.hotelId_wamid;
  const key = keyFor(hotelId, wamid);
  const existing = messageStore.get(key);
  if (existing) return existing;                    // update: {} → no-op
  const row = { id: `msg_${++seq}`, ...args.create };
  messageStore.set(key, row);
  return row;
});
const messageCreate = vi.fn(async (args: any) => ({ id: `msg_${++seq}`, ...args.data }));

vi.mock("../db/connect", () => ({
  default: {
    guest:   { upsert: (...a: any[]) => guestUpsert(...a) },
    message: {
      findUnique: (...a: any[]) => messageFindUnique(a[0]),
      upsert:     (...a: any[]) => messageUpsert(a[0]),
      create:     (...a: any[]) => messageCreate(a[0]),
    },
  },
}));

const emitToHotel = vi.fn();
vi.mock("../realtime/emit", () => ({ emitToHotel: (...a: any[]) => emitToHotel(...a) }));

import { persistEchoedOutboundMessage } from "./echoPersist.service";

function input(overrides: any = {}) {
  return {
    hotelId:     "hotel_1",
    fromPhone:   "919746372102",
    guestPhone:  "996345286534670",
    body:        "See you at check-in!",
    messageType: "text",
    wamid:       "mid.ECHO1",
    channel:     "INSTAGRAM" as any,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  messageStore = new Map();
  seq = 0;
  guestUpsert.mockResolvedValue({ id: "guest_1" });
});

describe("persistEchoedOutboundMessage", () => {
  it("stores an OUT/SENT message keyed to the upserted guest and emits message:new", async () => {
    const { message, isNew } = await persistEchoedOutboundMessage(input());

    expect(guestUpsert).toHaveBeenCalledWith({
      where:  { phone_hotelId: { phone: "996345286534670", hotelId: "hotel_1" } },
      create: { phone: "996345286534670", hotelId: "hotel_1" },
      update: {},
    });
    expect(messageUpsert).toHaveBeenCalledTimes(1);
    const call = messageUpsert.mock.calls[0]![0];
    expect(call.where).toEqual({ hotelId_wamid: { hotelId: "hotel_1", wamid: "mid.ECHO1" } });
    expect(call.update).toEqual({});        // never overwrites an existing row
    expect(call.create).toMatchObject({
      direction:   "OUT",
      status:      "SENT",
      fromPhone:   "919746372102",
      toPhone:     "996345286534670",
      body:        "See you at check-in!",
      messageType: "text",
      guestId:     "guest_1",
      channel:     "INSTAGRAM",
      wamid:       "mid.ECHO1",
    });

    expect(isNew).toBe(true);
    expect(emitToHotel).toHaveBeenCalledTimes(1);
    expect(emitToHotel).toHaveBeenCalledWith("hotel_1", "message:new", { message });
  });

  it("duplicate mids are ignored: one row, message:new emitted exactly once", async () => {
    await persistEchoedOutboundMessage(input());
    const second = await persistEchoedOutboundMessage(input()); // Meta redelivery

    expect(messageStore.size).toBe(1);      // dedup — same (hotelId, wamid) row
    expect(second.isNew).toBe(false);
    expect(emitToHotel).toHaveBeenCalledTimes(1); // UI never re-notified
  });

  it("no wamid → plain create fallback (no dedup key available)", async () => {
    await persistEchoedOutboundMessage(input({ wamid: null }));

    expect(messageFindUnique).not.toHaveBeenCalled();
    expect(messageUpsert).not.toHaveBeenCalled();
    expect(messageCreate).toHaveBeenCalledTimes(1);
    expect(messageCreate.mock.calls[0]![0].data).not.toHaveProperty("wamid");
    expect(emitToHotel).toHaveBeenCalledTimes(1);
  });

  it("metadata is persisted when provided (echoed interactive sends)", async () => {
    const metadata = { interactive: { type: "list", sections: [] } };
    await persistEchoedOutboundMessage(input({ metadata, wamid: "mid.META1" }));

    expect(messageUpsert.mock.calls[0]![0].create.metadata).toEqual(metadata);
  });
});
