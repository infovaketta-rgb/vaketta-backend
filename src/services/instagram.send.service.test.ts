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
vi.mock("../utils/encryption.utils", () => ({
  decryptInstagramToken: (...a: any[]) => decryptInstagramToken(...a),
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import {
  sendInstagramTextMessage,
  sendInstagramQuickReplies,
  sendInstagramButtonTemplate,
  sendInstagramGenericTemplate,
  sendInstagramMediaMessage,
} from "./instagram.send.service";

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

  it("splits text over 950 chars into sequential sends, awaiting each in order", async () => {
    const long = ("word ".repeat(210)).trim(); // > 950 chars, splits on spaces
    fetchMock
      .mockResolvedValueOnce(graphOk({ message_id: "mid.1" }))
      .mockResolvedValueOnce(graphOk({ message_id: "mid.2" }));

    const result = await sendInstagramTextMessage({ ...INPUT, text: long });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const body2 = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(body1.message.text.length).toBeLessThanOrEqual(950);
    expect(body2.message.text.length).toBeLessThanOrEqual(950);
    // Chunks rejoin to the original content (split on spaces, so join with a space).
    expect(`${body1.message.text} ${body2.message.text}`).toBe(long);
    // Result reflects the last successful chunk send.
    expect(result).toEqual({ message_id: "mid.2" });
  });

  it("stops sending remaining chunks and surfaces the real error when a later chunk fails", async () => {
    const long = ("word ".repeat(400)).trim(); // splits into 3+ chunks
    fetchMock
      .mockResolvedValueOnce(graphOk({ message_id: "mid.1" }))
      .mockResolvedValueOnce(graphOk({ message_id: "mid.2" }))
      .mockResolvedValueOnce(graphError(400, { error: { message: "Recipient not reachable", code: 551 } }));

    await expect(sendInstagramTextMessage({ ...INPUT, text: long })).rejects.toThrow(/Recipient not reachable/);
    // Exactly 3 calls: two succeeded, the third failed and stopped the loop (no 4th send).
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not split text at or under the 950-char limit — single send, unchanged body", async () => {
    fetchMock.mockResolvedValue(graphOk({ message_id: "mid.SHORT" }));
    const exact950 = "a".repeat(950);

    await sendInstagramTextMessage({ ...INPUT, text: exact950 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.message.text).toBe(exact950);
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

// ── Interactive senders — exact IG-Login wire shapes ─────────────────────────

describe("Instagram interactive senders — wire shapes", () => {
  const parseBody = () => JSON.parse(fetchMock.mock.calls[0]![1].body);

  beforeEach(() => {
    fetchMock.mockResolvedValue(graphOk({ message_id: "mid.INT" }));
  });

  it("quick replies: text + quick_replies[] with content_type/title(≤20)/payload", async () => {
    await sendInstagramQuickReplies({
      toPhone: "996345286534670", hotelId: "hotel_1",
      text: "Pick one:",
      quickReplies: [
        { title: "A very long option title over 20", payload: "opt_0" },
        { title: "Second", payload: "opt_1" },
      ],
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://graph.instagram.com/v25.0/me/messages");
    expect(parseBody()).toEqual({
      recipient: { id: "996345286534670" },
      message: {
        text: "Pick one:",
        quick_replies: [
          { content_type: "text", title: "A very long option t", payload: "opt_0" },
          { content_type: "text", title: "Second",               payload: "opt_1" },
        ],
      },
    });
  });

  it("button template: attachment/template/button with postback buttons", async () => {
    await sendInstagramButtonTemplate({
      toPhone: "996345286534670", hotelId: "hotel_1",
      text: "Confirm?",
      buttons: [{ title: "✅ Confirm", payload: "CONFIRM_BOOKING" }],
    });
    expect(parseBody()).toEqual({
      recipient: { id: "996345286534670" },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: "Confirm?",
            buttons: [{ type: "postback", title: "✅ Confirm", payload: "CONFIRM_BOOKING" }],
          },
        },
      },
    });
  });

  it("generic template: elements with title/subtitle(≤80)/image_url/postbacks", async () => {
    await sendInstagramGenericTemplate({
      toPhone: "996345286534670", hotelId: "hotel_1",
      elements: [{
        title: "Deluxe", subtitle: "₹5,000/night — Sea view", imageUrl: "https://r2/d.jpg",
        buttons: [{ title: "Choose", payload: "room_rt1" }, { title: "View Photos", payload: "photos_rt1" }],
      }],
    });
    expect(parseBody()).toEqual({
      recipient: { id: "996345286534670" },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: [{
              title: "Deluxe", subtitle: "₹5,000/night — Sea view", image_url: "https://r2/d.jpg",
              buttons: [
                { type: "postback", title: "Choose",      payload: "room_rt1" },
                { type: "postback", title: "View Photos", payload: "photos_rt1" },
              ],
            }],
          },
        },
      },
    });
  });

  it("media: attachment with type + payload.url", async () => {
    await sendInstagramMediaMessage({
      toPhone: "996345286534670", hotelId: "hotel_1", mediaType: "image", mediaUrl: "https://r2/x.jpg",
    });
    expect(parseBody()).toEqual({
      recipient: { id: "996345286534670" },
      message: { attachment: { type: "image", payload: { url: "https://r2/x.jpg" } } },
    });
  });

  it("interactive senders share the outbound gate: disabled flag throws, no fetch", async () => {
    vi.stubEnv("INSTAGRAM_OUTBOUND_ENABLED", "false");
    await expect(
      sendInstagramQuickReplies({ toPhone: "x", hotelId: "hotel_1", text: "t", quickReplies: [] }),
    ).rejects.toThrow("Instagram outbound disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
