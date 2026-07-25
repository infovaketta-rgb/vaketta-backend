/**
 * Regression tests for the WhatsApp connect / history sync flow in
 * settings.service.ts.
 *
 * Design: connectWhatsAppEmbeddedSignup triggers Meta's smb_app_data history
 * sync (and resets Hotel.historySyncStatus to "pending") on EVERY successful
 * embedded signup call — first-time connect AND reconnect alike. This is
 * intentional: duplicate protection is NOT connect-time gating, it lives at
 * the DB layer — Message has a `@@unique([hotelId, wamid])` constraint, and
 * history.service.ts's processThread/processSmbMessageEcho both write via
 * `prisma.message.upsert({ where: { hotelId_wamid }, update: {} })` instead
 * of a check-then-create race. So even if a reconnect makes Meta redeliver
 * history it already sent once, every message resolves to the SAME row
 * instead of inserting a duplicate — see history.service.test.ts for the
 * upsert/idempotency coverage itself.
 *
 * triggerWhatsAppHistoryResync is a standalone explicit re-sync path for an
 * already-connected hotel (e.g. a "Re-sync chat history" UI action) that
 * reuses stored credentials without the full OAuth dialog. It relies on the
 * same DB-level dedup for safety.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const hotelConfigFindUnique = vi.fn();
const hotelConfigUpsert     = vi.fn().mockResolvedValue({});
const hotelUpdate           = vi.fn().mockResolvedValue({});
const platformSettingsFindUnique = vi.fn().mockResolvedValue({ id: "global", metaApiVersion: "v25.0" });

vi.mock("../db/connect", () => ({
  default: {
    hotelConfig:      {
      findUnique: (...a: any[]) => hotelConfigFindUnique(...a),
      upsert:     (...a: any[]) => hotelConfigUpsert(...a),
    },
    hotel:            { update: (...a: any[]) => hotelUpdate(...a) },
    platformSettings: { findUnique: (...a: any[]) => platformSettingsFindUnique(...a) },
  },
}));
vi.mock("../queue/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));
vi.mock("../utils/encryption.utils", () => ({
  encryptInstagramToken: vi.fn((t: string) => `enc:${t}`),
  encryptWhatsAppToken:  vi.fn((t: string) => `enc:${t}`),
  decryptWhatsAppToken:  vi.fn((t: string) => t.replace(/^enc:/, "")),
}));
vi.mock("./whatsapp.send.service", () => ({
  invalidateCredentialsCache: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { connectWhatsAppEmbeddedSignup, triggerWhatsAppHistoryResync } from "./settings.service";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FACEBOOK_APP_ID     = "app123";
  process.env.FACEBOOK_APP_SECRET = "secret123";
  platformSettingsFindUnique.mockResolvedValue({ id: "global", metaApiVersion: "v25.0" });
  hotelConfigUpsert.mockResolvedValue({});
  hotelUpdate.mockResolvedValue({});

  // Default fetch sequence for connectWhatsAppEmbeddedSignup:
  //   1. oauth/access_token  2. WABA subscribed_apps  3. coexistence fields  4. smb_app_data
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/oauth/access_token")) return jsonResponse({ access_token: "TOKEN123" });
    if (url.includes("/subscribed_apps"))     return jsonResponse({ success: true });
    if (url.includes("/smb_app_data"))        return jsonResponse({ success: true });
    return jsonResponse({}, false, 404);
  });
});

describe("connectWhatsAppEmbeddedSignup — history sync fires on every successful signup", () => {
  it("first-time connect (no prior metaPhoneNumberId) triggers history sync", async () => {
    hotelConfigFindUnique.mockResolvedValue(null); // no existing config at all

    await connectWhatsAppEmbeddedSignup("hotel_1", "code", "waba_1", "phone_1", "https://x/redirect");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/phone_1/smb_app_data"),
      expect.anything(),
    );
    expect(hotelUpdate).toHaveBeenCalledWith({
      where: { id: "hotel_1" },
      data: expect.objectContaining({
        historySyncStatus:    "pending",
        historySyncCompleted: null,
      }),
    });
  });

  it("reconnect of the SAME phone number also triggers history sync (DB dedup is the safety net, not gating)", async () => {
    hotelConfigFindUnique.mockResolvedValue({ metaPhoneNumberId: "phone_1" }); // already connected

    await connectWhatsAppEmbeddedSignup("hotel_1", "code", "waba_1", "phone_1", "https://x/redirect");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/phone_1/smb_app_data"),
      expect.anything(),
    );
    expect(hotelUpdate).toHaveBeenCalledWith({
      where: { id: "hotel_1" },
      data: expect.objectContaining({ historySyncStatus: "pending" }),
    });
  });

  it("reconnect with a DIFFERENT phone number swapped in also triggers history sync", async () => {
    hotelConfigFindUnique.mockResolvedValue({ metaPhoneNumberId: "phone_1" });

    await connectWhatsAppEmbeddedSignup("hotel_1", "code", "waba_1", "phone_2", "https://x/redirect");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/phone_2/smb_app_data"),
      expect.anything(),
    );
    expect(hotelUpdate).toHaveBeenCalledWith({
      where: { id: "hotel_1" },
      data: expect.objectContaining({ historySyncStatus: "pending" }),
    });
  });

  it("does not query hotelConfig.findUnique for a first-connect/reconnect distinction (no gating logic)", async () => {
    hotelConfigFindUnique.mockResolvedValue({ metaPhoneNumberId: "phone_1" });
    await connectWhatsAppEmbeddedSignup("hotel_1", "code", "waba_1", "phone_1", "https://x/redirect");
    // Only hotelConfig.upsert (credential persistence) should run — no pre-read.
    expect(hotelConfigFindUnique).not.toHaveBeenCalled();
    expect(hotelConfigUpsert).toHaveBeenCalledTimes(1);
  });
});

describe("triggerWhatsAppHistoryResync — explicit standalone resync", () => {
  it("triggers smb_app_data and resets historySyncStatus using stored credentials", async () => {
    hotelConfigFindUnique.mockResolvedValue({
      metaPhoneNumberId:        "phone_1",
      metaAccessTokenEncrypted: "enc:TOKEN123",
    });

    await triggerWhatsAppHistoryResync("hotel_1");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/phone_1/smb_app_data"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(hotelUpdate).toHaveBeenCalledWith({
      where: { id: "hotel_1" },
      data: expect.objectContaining({
        historySyncStatus:    "pending",
        historySyncCompleted: null,
      }),
    });
  });

  it("throws when the hotel has no stored WhatsApp credentials", async () => {
    hotelConfigFindUnique.mockResolvedValue(null);
    await expect(triggerWhatsAppHistoryResync("hotel_1")).rejects.toThrow(/not connected/i);
    expect(hotelUpdate).not.toHaveBeenCalled();
  });

  it("throws and does not reset status when Meta rejects the smb_app_data call", async () => {
    hotelConfigFindUnique.mockResolvedValue({
      metaPhoneNumberId:        "phone_1",
      metaAccessTokenEncrypted: "enc:TOKEN123",
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/smb_app_data")) return jsonResponse({ error: { message: "not eligible" } }, false, 400);
      return jsonResponse({}, false, 404);
    });

    await expect(triggerWhatsAppHistoryResync("hotel_1")).rejects.toThrow(/not eligible/);
    expect(hotelUpdate).not.toHaveBeenCalled();
  });
});
