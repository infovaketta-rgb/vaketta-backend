/**
 * Regression tests for sendInstagramTextMessage — outbound Instagram API migration.
 *
 * Root cause guarded here: the connect flow is "Instagram API with Instagram
 * Login" and stores a long-lived IG USER token (IGAA… prefix), but the send
 * path used to POST it to the legacy Messenger-Platform endpoint
 * graph.facebook.com/{ig-id}/messages — a host that only parses EAA… Page
 * tokens and rejects IG-Login tokens with OAuthException 190 ("Cannot parse
 * access token"). Sends must target graph.instagram.com/{v}/me/messages so the
 * auth flow and the send API belong to the same Meta API generation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hotelConfigFindUnique      = vi.fn();
const platformSettingsFindUnique = vi.fn().mockResolvedValue({ metaApiVersion: "v25.0" });

vi.mock("../db/connect", () => ({
  default: {
    hotelConfig:      { findUnique: (...a: any[]) => hotelConfigFindUnique(...a) },
    platformSettings: { findUnique: (...a: any[]) => platformSettingsFindUnique(...a) },
  },
}));

const decryptInstagramToken = vi.fn((..._a: any[]) => "IGAA_TEST_TOKEN_abc123");
vi.mock("./instagram.service", () => ({
  decryptInstagramToken: (...a: any[]) => decryptInstagramToken(...a),
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import { sendInstagramTextMessage } from "./instagram.send.service";

const fetchMock = vi.fn();

function graphOk(json: any) {
  return { ok: true, status: 200, json: async () => json };
}
function graphError(status: number, json: any) {
  return { ok: false, status, json: async () => json };
}

function connectedConfig(overrides: any = {}) {
  return {
    hotelId:                       "hotel_1",
    instagramAccessTokenEncrypted: "iv:cipher:tag",
    instagramBusinessAccountId:    "17841443797859809",
    ...overrides,
  };
}

const INPUT = { toPhone: "996345286534670", text: "See you at check-in!", hotelId: "hotel_1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("INSTAGRAM_OUTBOUND_ENABLED", "true");
  vi.stubEnv("MOCK_INSTAGRAM_SEND", "false");
  hotelConfigFindUnique.mockResolvedValue(connectedConfig());
  platformSettingsFindUnique.mockResolvedValue({ metaApiVersion: "v25.0" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sendInstagramTextMessage — IG-Login messaging endpoint", () => {
  it("POSTs to graph.instagram.com /me/messages with the Bearer token and IG-Login body shape", async () => {
    fetchMock.mockResolvedValue(graphOk({ message_id: "mid.OUT1", recipient_id: "996345286534670" }));

    const result = await sendInstagramTextMessage(INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;

    // The endpoint of the SAME API generation as the IGAA… token — never the
    // legacy Messenger-Platform host, which throws OAuthException 190 on it.
    expect(url).toBe("https://graph.instagram.com/v25.0/me/messages");
    expect(url).not.toContain("graph.facebook.com");

    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer IGAA_TEST_TOKEN_abc123");
    expect(init.headers["Content-Type"]).toBe("application/json");

    // recipient + message only — messaging_type was a Messenger-Platform field
    expect(JSON.parse(init.body)).toEqual({
      recipient: { id: "996345286534670" },
      message:   { text: "See you at check-in!" },
    });

    // Response passthrough unchanged (message.service reads message_id)
    expect(result).toEqual({ message_id: "mid.OUT1", recipient_id: "996345286534670" });
  });

  it("uses the decrypted token from HotelConfig for the right hotel", async () => {
    fetchMock.mockResolvedValue(graphOk({ message_id: "mid.OUT2" }));

    await sendInstagramTextMessage(INPUT);

    expect(hotelConfigFindUnique).toHaveBeenCalledWith({ where: { hotelId: "hotel_1" } });
    expect(decryptInstagramToken).toHaveBeenCalledWith("iv:cipher:tag");
  });

  it("throws when INSTAGRAM_OUTBOUND_ENABLED is not 'true' — no network call", async () => {
    vi.stubEnv("INSTAGRAM_OUTBOUND_ENABLED", "false");

    await expect(sendInstagramTextMessage(INPUT)).rejects.toThrow("Instagram outbound disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mock mode returns null without touching the network", async () => {
    vi.stubEnv("MOCK_INSTAGRAM_SEND", "true");

    const result = await sendInstagramTextMessage(INPUT);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still fails fast when the connect flow never stored a business account id", async () => {
    hotelConfigFindUnique.mockResolvedValue(connectedConfig({ instagramBusinessAccountId: null }));

    await expect(sendInstagramTextMessage(INPUT)).rejects.toThrow(
      "Instagram business account ID not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("4xx Graph errors are NOT retried (single call) and surface the OAuth payload", async () => {
    fetchMock.mockResolvedValue(
      graphError(400, { error: { message: "Invalid OAuth access token", code: 190 } }),
    );

    await expect(sendInstagramTextMessage(INPUT)).rejects.toThrow(/Invalid OAuth access token/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx Graph errors are retried, then succeed", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(graphError(500, { error: { message: "transient" } }))
        .mockResolvedValueOnce(graphOk({ message_id: "mid.RETRY" }));

      const promise = sendInstagramTextMessage(INPUT);
      await vi.advanceTimersByTimeAsync(2_000); // covers the 500ms+jitter backoff

      await expect(promise).resolves.toEqual({ message_id: "mid.RETRY" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Retry hits the SAME IG-Login endpoint
      expect(fetchMock.mock.calls[1]![0]).toBe("https://graph.instagram.com/v25.0/me/messages");
    } finally {
      vi.useRealTimers();
    }
  });
});
