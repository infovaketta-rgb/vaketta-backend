/**
 * Regression tests for history.service — WhatsApp Coexistence history sync.
 *
 * Root cause guarded here: the handler previously read the payload one level too
 * deep (`value.data.metadata` / `value.data.history`). Meta's `history` change
 * `value` has NO `data` envelope — metadata is at `value.metadata`, chunks at
 * `value.history` (same shape the sibling smb_message_echoes handler reads). The
 * wrong path made both phone identifiers `undefined`, so resolveHotel returned
 * null and NO messages were ever stored ("history webhook: hotel not found").
 *
 * These tests feed a realistic `history` value through processHistoryWebhook and
 * assert the hotel resolves and Message rows are written — locking the contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock prisma ───────────────────────────────────────────────────────────────

const hotelConfigFindFirst = vi.fn();
const hotelFindUnique      = vi.fn();
const hotelUpdate          = vi.fn().mockResolvedValue({});
const guestUpsert          = vi.fn();
const messageFindFirst     = vi.fn().mockResolvedValue(null); // smb echo fallback (no wamid) path

// In-memory (hotelId, wamid) store so the mocked upsert/findUnique can
// exercise real create-vs-no-op semantics — the same behaviour the DB unique
// constraint guarantees. Cleared in beforeEach.
let messageStore: Map<string, { id: string; data: any }>;
let messageCreateSeq = 0;

function keyFor(hotelId: string, wamid: string | null) {
  return `${hotelId}::${wamid}`;
}

// smb echo "isNew" pre-check — reads the SAME store the upsert mock writes,
// so a race between the pre-check and the upsert is visible in tests too.
const messageFindUnique = vi.fn(async (...a: any[]) => {
  const args = a[0];
  const { hotelId, wamid } = args.where.hotelId_wamid;
  const existing = messageStore.get(keyFor(hotelId, wamid));
  return existing ? { id: existing.id } : null;
});

const messageUpsert = vi.fn(async (...a: any[]) => {
  const args = a[0];
  const { hotelId, wamid } = args.where.hotelId_wamid;
  const key = keyFor(hotelId, wamid);
  const existing = messageStore.get(key);
  if (existing) return existing.data; // update: {} → no-op, return the stored row
  const row = { id: `msg_${++messageCreateSeq}`, ...args.create };
  messageStore.set(key, { id: row.id, data: row });
  return row;
});

// Plain create — used only for the smb-echo no-wamid fallback path.
const messageCreate = vi.fn(async (...a: any[]) => ({ id: `msg_${++messageCreateSeq}`, ...a[0].data }));

vi.mock("../db/connect", () => ({
  default: {
    hotelConfig: { findFirst: (...a: any[]) => hotelConfigFindFirst(...a) },
    hotel:       {
      findUnique: (...a: any[]) => hotelFindUnique(...a),
      update:     (...a: any[]) => hotelUpdate(...a),
    },
    guest:       { upsert: (...a: any[]) => guestUpsert(...a) },
    message:     {
      findFirst:  (...a: any[]) => messageFindFirst(...a),
      findUnique: (...a: any[]) => messageFindUnique(...a),
      create:     (...a: any[]) => messageCreate(...a),
      upsert:     (...a: any[]) => messageUpsert(...a),
    },
  },
}));

// ── mock realtime emit + logger (keep real normalizePhone + prisma enums) ───────

vi.mock("../realtime/emit", () => ({ emitToHotel: vi.fn() }));
vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

// ── mock the history-media queue (avoids touching real Redis in tests) ─────────

const historyMediaQueueAdd = vi.fn().mockResolvedValue({ id: "job_1" });
vi.mock("../queue/historyMedia.queue", () => ({
  historyMediaQueue: { add: (...a: any[]) => historyMediaQueueAdd(...a) },
}));

import { processHistoryWebhook } from "./history.service";

// A realistic Coexistence `history` change value — NO `data` envelope.
function historyValue() {
  return {
    messaging_product: "whatsapp",
    metadata: {
      display_phone_number: "15550001111",
      phone_number_id:      "PNID_123",
    },
    history: [
      {
        // Meta sends phase/progress as NUMBERS (numeric enum) — not strings.
        metadata: { phase: 2, progress: 100 },
        threads: [
          {
            id: "919812345678",
            messages: [
              { id: "wamid.AAA", from: "919812345678", type: "text",
                text: { body: "Hi, is a room available?" }, timestamp: "1700000000" },
              { id: "wamid.BBB", from: "15550001111", type: "text",
                text: { body: "Yes! Checking dates." }, timestamp: "1700000100",
                history_context: { status: "read" } },
            ],
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  messageCreateSeq = 0;
  messageStore = new Map(); // messageFindUnique/messageUpsert both read/write this
  messageFindFirst.mockResolvedValue(null);
  hotelUpdate.mockResolvedValue({});
  guestUpsert.mockResolvedValue({ id: "guest_1" });
  historyMediaQueueAdd.mockResolvedValue({ id: "job_1" });
  // resolveHotel: matched by metaPhoneNumberId → hotelConfig.findFirst
  hotelConfigFindFirst.mockResolvedValue({
    hotel: { id: "hotel_1", phone: "15550001111" },
  });
  // idempotency guard read (not yet complete)
  hotelFindUnique.mockResolvedValue({ historySyncStatus: "pending", historySyncStarted: null });
});

describe("processHistoryWebhook — payload path (regression)", () => {
  it("resolves the hotel from value.metadata and stores both messages", async () => {
    await processHistoryWebhook(historyValue());

    expect(hotelConfigFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { metaPhoneNumberId: "PNID_123" } }),
    );
    expect(messageUpsert).toHaveBeenCalledTimes(2);

    // Inbound guest message stored IN with RECEIVED-family status
    const inArgs = messageUpsert.mock.calls.find(
      (c) => c[0].create.wamid === "wamid.AAA",
    )?.[0].create;
    expect(inArgs.direction).toBe("IN");
    expect(inArgs.body).toBe("Hi, is a room available?");

    // Outbound hotel message stored OUT with READ status (from history_context)
    const outArgs = messageUpsert.mock.calls.find(
      (c) => c[0].create.wamid === "wamid.BBB",
    )?.[0].create;
    expect(outArgs.direction).toBe("OUT");
    expect(outArgs.status).toBe("READ");
  });

  it("bails with no writes when metadata is missing (unresolvable hotel)", async () => {
    await processHistoryWebhook({ history: [] }); // no metadata → resolveHotel null
    expect(messageUpsert).not.toHaveBeenCalled();
  });

  it("skips entirely when history sync already complete (idempotency)", async () => {
    hotelFindUnique.mockResolvedValue({ historySyncStatus: "complete", historySyncStarted: new Date() });
    await processHistoryWebhook(historyValue());
    expect(messageUpsert).not.toHaveBeenCalled();
  });

  it("does not throw when phase/progress are numbers, not strings (regression)", async () => {
    // phase:2 (number) previously crashed: (2).toUpperCase is not a function.
    const v = historyValue();
    v.history[0]!.metadata = { phase: 3, progress: 100 } as any; // numeric enum + numeric progress
    await expect(processHistoryWebhook(v)).resolves.toBeUndefined();
    expect(messageUpsert).toHaveBeenCalledTimes(2);
    // progress 100 → sync marked complete
    expect(hotelUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ historySyncStatus: "complete" }) }),
    );
  });
});

describe("processHistoryWebhook — media import (queued backfill)", () => {
  function historyValueWithImage() {
    const v = historyValue();
    v.history[0]!.threads[0]!.messages = [
      {
        id: "wamid.IMG1",
        from: "919812345678",
        type: "image",
        image: { id: "MEDIA_ID_1", mime_type: "image/jpeg", caption: "room pic" },
        timestamp: "1700000200",
      },
    ] as any;
    return v;
  }

  it("stores a pending:// placeholder and queues a history-media job (does not download inline)", async () => {
    await processHistoryWebhook(historyValueWithImage());

    expect(messageUpsert).toHaveBeenCalledTimes(1);
    const data = messageUpsert.mock.calls[0]![0].create;
    expect(data.messageType).toBe("image");
    expect(data.mediaUrl).toBe("pending://MEDIA_ID_1");
    expect(data.mimeType).toBe("image/jpeg");
    expect(data.body).toBe("room pic"); // caption

    expect(historyMediaQueueAdd).toHaveBeenCalledTimes(1);
    const [jobName, jobData, jobOpts] = historyMediaQueueAdd.mock.calls[0]!;
    expect(jobName).toBe("history-media");
    expect(jobData).toMatchObject({
      messageId:  "msg_1",       // created row's id, not a content-based lookup
      mediaId:    "MEDIA_ID_1",
      mimeType:   "image/jpeg",
      hotelPhone: "15550001111",
    });
    expect(jobOpts).toEqual({ jobId: "msg_1" }); // idempotent re-enqueue, targets the exact row
  });

  it("does not queue a job or set mediaUrl for plain text messages", async () => {
    await processHistoryWebhook(historyValue()); // both messages are type:"text"
    expect(historyMediaQueueAdd).not.toHaveBeenCalled();
    for (const call of messageUpsert.mock.calls) {
      expect(call[0]!.create.mediaUrl).toBeUndefined();
    }
  });

  it("never emits a realtime event for historical media (stays silent)", async () => {
    const { emitToHotel } = await import("../realtime/emit");
    await processHistoryWebhook(historyValueWithImage());
    // Only the per-chunk history:sync_progress emit — no message:media_ready
    const events = (emitToHotel as any).mock.calls.map((c: any[]) => c[1]);
    expect(events).toEqual(["history:sync_progress"]);
  });
});

describe("processHistoryWebhook — interactive replies (title in body, id in metadata)", () => {
  it("stores the human-readable title as body and the payload id/type in metadata", async () => {
    const v = historyValue();
    v.history[0]!.threads[0]!.messages = [
      {
        id: "wamid.LIST1", from: "919812345678", type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "opt_2", title: "Deluxe Room", description: "Sea view" } },
        timestamp: "1700000300",
      },
      {
        id: "wamid.QR1", from: "919812345678", type: "button",
        button: { payload: "room_abc123", text: "Select Room" },
        timestamp: "1700000400",
      },
    ] as any;

    await processHistoryWebhook(v);
    expect(messageUpsert).toHaveBeenCalledTimes(2);

    const listArgs = messageUpsert.mock.calls.find((c) => c[0].create.wamid === "wamid.LIST1")?.[0].create;
    expect(listArgs.messageType).toBe("text");
    expect(listArgs.body).toBe("Deluxe Room"); // what the guest saw — not "opt_2"
    expect(listArgs.metadata).toEqual({
      interactiveReply: { type: "list_reply", id: "opt_2", title: "Deluxe Room", description: "Sea view" },
    });

    const qrArgs = messageUpsert.mock.calls.find((c) => c[0].create.wamid === "wamid.QR1")?.[0].create;
    expect(qrArgs.body).toBe("Select Room");
    expect(qrArgs.metadata).toEqual({
      interactiveReply: { type: "quick_reply", id: "room_abc123", title: "Select Room", description: null },
    });
  });

  it("keeps the payload id as body when Meta omits the title (legacy hide filter applies)", async () => {
    const v = historyValue();
    v.history[0]!.threads[0]!.messages = [
      {
        id: "wamid.LIST2", from: "919812345678", type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "opt_1" } },
        timestamp: "1700000500",
      },
    ] as any;

    await processHistoryWebhook(v);
    const args = messageUpsert.mock.calls[0]![0].create;
    expect(args.body).toBe("opt_1");
    expect(args.metadata.interactiveReply.id).toBe("opt_1");
  });

  it("leaves outbound interactive sends and plain text untouched (no metadata)", async () => {
    const v = historyValue();
    v.history[0]!.threads[0]!.messages = [
      {
        id: "wamid.OUTLIST", from: "15550001111", type: "interactive",
        interactive: { type: "list", action: { button: "View Menu", sections: [] } },
        timestamp: "1700000600",
      },
      { id: "wamid.TXT", from: "919812345678", type: "text",
        text: { body: "hello" }, timestamp: "1700000700" },
    ] as any;

    await processHistoryWebhook(v);
    for (const call of messageUpsert.mock.calls) {
      expect(call[0]!.create.metadata).toBeUndefined();
    }
  });
});

// ── Idempotency / duplicate-import regression suite ─────────────────────────
//
// Covers the scenarios from the "fully idempotent" requirement:
//   1. Same history webhook delivered twice (Meta re-delivery)
//   2. Re-import after reconnect (historySyncStatus manually reset to pending,
//      simulating what happens when a hotel explicitly resyncs)
//   3. Concurrent processing of the same chunk (Promise.all race)
//   4. Unique-constraint behaviour: upsert dedups on (hotelId, wamid), never
//      creates two rows for the same pair, and doesn't affect null-wamid rows.
//
// The `messageUpsert` mock models the SAME semantics the DB unique constraint
// enforces: a second upsert for an already-seen (hotelId, wamid) is a no-op
// that returns the ORIGINAL stored row, never a second one.

describe("processHistoryWebhook — idempotent duplicate delivery (DB-safe upsert)", () => {
  it("processing the identical webhook payload twice stores each wamid exactly once", async () => {
    const v = historyValue();

    await processHistoryWebhook(v);
    await processHistoryWebhook(v); // Meta re-delivery / retry of the same chunk

    expect(messageUpsert).toHaveBeenCalledTimes(4); // 2 messages × 2 deliveries
    // But only 2 DISTINCT rows ever exist in the backing store — the second
    // delivery's upserts both resolved to existing (hotelId, wamid) pairs.
    expect(messageStore.size).toBe(2);
  });

  it("does not create a second row when the same wamid arrives in two different chunks of one webhook call", async () => {
    const v = historyValue();
    // Duplicate the same thread/message into a second chunk within ONE webhook
    // delivery — simulates Meta re-sending a chunk within the same batch.
    v.history.push(JSON.parse(JSON.stringify(v.history[0])));

    await processHistoryWebhook(v);

    expect(messageUpsert).toHaveBeenCalledTimes(4); // 2 messages × 2 chunks
    expect(messageStore.size).toBe(2); // still just wamid.AAA and wamid.BBB
  });

  it("concurrent processing of the same message does not create duplicate rows", async () => {
    const v = historyValue();

    // Two "chunks" processed concurrently (Promise.all) both containing the
    // exact same wamid — models a race between overlapping webhook deliveries
    // rather than the sequential for-loop processHistoryWebhook normally uses.
    await Promise.all([processHistoryWebhook(v), processHistoryWebhook(v)]);

    expect(messageStore.size).toBe(2); // wamid.AAA + wamid.BBB, never duplicated
    // Every upsert call targeted the same two (hotelId, wamid) keys — none
    // produced a third distinct row.
    const keys = new Set(
      messageUpsert.mock.calls.map((c) => keyFor(c[0].where.hotelId_wamid.hotelId, c[0].where.hotelId_wamid.wamid)),
    );
    expect(keys.size).toBe(2);
  });

  it("upsert targets the (hotelId, wamid) compound unique key, not wamid alone", async () => {
    await processHistoryWebhook(historyValue());
    for (const call of messageUpsert.mock.calls) {
      expect(call[0].where).toHaveProperty("hotelId_wamid");
      expect(call[0].where.hotelId_wamid).toMatchObject({ hotelId: "hotel_1" });
      expect(call[0].update).toEqual({}); // no-op on conflict — never overwrites an existing row
    }
  });
});

describe("processSmbMessageEcho — idempotent duplicate delivery", () => {
  function echoValue(overrides: Partial<{ id: string; to: string; body: string }> = {}) {
    return {
      metadata: { phone_number_id: "PNID_123", display_phone_number: "15550001111" },
      messages: [
        {
          id:   overrides.id   ?? "wamid.ECHO1",
          to:   overrides.to   ?? "919812345678",
          type: "text",
          text: { body: overrides.body ?? "Room 4 is ready for you." },
        },
      ],
    };
  }

  it("stores the echo once and emits message:new exactly once, even if delivered twice", async () => {
    const { emitToHotel } = await import("../realtime/emit");
    const { processSmbMessageEcho } = await import("./history.service");

    const v = echoValue();
    await processSmbMessageEcho(v);
    await processSmbMessageEcho(v); // duplicate delivery

    expect(messageUpsert).toHaveBeenCalledTimes(2); // both delivery attempts upsert...
    expect(messageStore.size).toBe(1);              // ...but only one row ever exists

    const newMessageEmits = (emitToHotel as any).mock.calls.filter((c: any[]) => c[1] === "message:new");
    expect(newMessageEmits).toHaveLength(1); // never re-notified for an already-stored echo
  });

  it("concurrent echo delivery for the same wamid still yields exactly one stored row", async () => {
    const { processSmbMessageEcho } = await import("./history.service");
    const v = echoValue();

    await Promise.all([processSmbMessageEcho(v), processSmbMessageEcho(v)]);

    expect(messageStore.size).toBe(1);
  });
});
