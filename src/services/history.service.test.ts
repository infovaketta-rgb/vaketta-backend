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
const messageFindFirst     = vi.fn().mockResolvedValue(null); // no dedup hits
const messageCreate        = vi.fn().mockResolvedValue({});

vi.mock("../db/connect", () => ({
  default: {
    hotelConfig: { findFirst: (...a: any[]) => hotelConfigFindFirst(...a) },
    hotel:       {
      findUnique: (...a: any[]) => hotelFindUnique(...a),
      update:     (...a: any[]) => hotelUpdate(...a),
    },
    guest:       { upsert: (...a: any[]) => guestUpsert(...a) },
    message:     {
      findFirst: (...a: any[]) => messageFindFirst(...a),
      create:    (...a: any[]) => messageCreate(...a),
    },
  },
}));

// ── mock realtime emit + logger (keep real normalizePhone + prisma enums) ───────

vi.mock("../realtime/emit", () => ({ emitToHotel: vi.fn() }));
vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
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
  messageFindFirst.mockResolvedValue(null);
  hotelUpdate.mockResolvedValue({});
  guestUpsert.mockResolvedValue({ id: "guest_1" });
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
    expect(messageCreate).toHaveBeenCalledTimes(2);

    // Inbound guest message stored IN with RECEIVED-family status
    const inArgs = messageCreate.mock.calls.find(
      (c) => c[0].data.wamid === "wamid.AAA",
    )?.[0].data;
    expect(inArgs.direction).toBe("IN");
    expect(inArgs.body).toBe("Hi, is a room available?");

    // Outbound hotel message stored OUT with READ status (from history_context)
    const outArgs = messageCreate.mock.calls.find(
      (c) => c[0].data.wamid === "wamid.BBB",
    )?.[0].data;
    expect(outArgs.direction).toBe("OUT");
    expect(outArgs.status).toBe("READ");
  });

  it("bails with no writes when metadata is missing (unresolvable hotel)", async () => {
    await processHistoryWebhook({ history: [] }); // no metadata → resolveHotel null
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("skips entirely when history sync already complete (idempotency)", async () => {
    hotelFindUnique.mockResolvedValue({ historySyncStatus: "complete", historySyncStarted: new Date() });
    await processHistoryWebhook(historyValue());
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("does not throw when phase/progress are numbers, not strings (regression)", async () => {
    // phase:2 (number) previously crashed: (2).toUpperCase is not a function.
    const v = historyValue();
    v.history[0]!.metadata = { phase: 3, progress: 100 } as any; // numeric enum + numeric progress
    await expect(processHistoryWebhook(v)).resolves.toBeUndefined();
    expect(messageCreate).toHaveBeenCalledTimes(2);
    // progress 100 → sync marked complete
    expect(hotelUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ historySyncStatus: "complete" }) }),
    );
  });
});
