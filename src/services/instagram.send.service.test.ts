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
import { toInstagramPlainText } from "./instagramFormat";

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

// ── Plain text at the send layer ─────────────────────────────────────────────
// Every guest-visible text field is passed through toInstagramPlainText before
// its split / .slice() cap. Ids, recipient and URLs are never touched.

describe("Instagram senders — WhatsApp markdown is removed from guest-visible text", () => {
  const bodyOf = (call = 0) => JSON.parse(fetchMock.mock.calls[call]![1].body);
  /** A string has no paired markdown iff the formatter leaves it unchanged. */
  const isPlain = (s: string) => toInstagramPlainText(s) === s;
  // Ids that LOOK like markdown, to prove they are never formatted.
  const ROOM_ID = "room_3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c";
  const ODD_ID  = "*keep_this*";

  beforeEach(() => {
    fetchMock.mockResolvedValue(graphOk({ message_id: "mid.FMT" }));
  });

  it("text: markdown removed; recipient id untouched", async () => {
    await sendInstagramTextMessage({
      toPhone: "_996345286534670_", hotelId: "hotel_1",
      text: "*Total: ₹24,000*\n_Reply *MENU* to see all options._",
    });
    const body = bodyOf();
    expect(body.message.text).toBe("Total: ₹24,000\nReply MENU to see all options.");
    expect(isPlain(body.message.text)).toBe(true);
    expect(body.recipient.id).toBe("_996345286534670_");
  });

  it("quick replies: body and every title plain; payloads byte-identical", async () => {
    await sendInstagramQuickReplies({
      toPhone: "996345286534670", hotelId: "hotel_1",
      text: "🏨 *Choose your room plan:*\n_Tap one below_",
      quickReplies: [
        { title: "*Plan 1*", payload: "plan_0" },
        { title: "_Mix it up_", payload: ODD_ID },
      ],
    });
    const msg = bodyOf().message;
    expect(msg.text).toBe("🏨 Choose your room plan:\nTap one below");
    expect(msg.quick_replies.map((q: any) => q.title)).toEqual(["Plan 1", "Mix it up"]);
    expect(msg.quick_replies.map((q: any) => q.payload)).toEqual(["plan_0", ODD_ID]);
    expect([msg.text, ...msg.quick_replies.map((q: any) => q.title)].every(isPlain)).toBe(true);
  });

  it("quick replies: the 20-char title cap is measured on the plain text", async () => {
    // 21 chars raw, 19 plain — formatting first means nothing is cut off.
    await sendInstagramQuickReplies({
      toPhone: "996345286534670", hotelId: "hotel_1", text: "Pick:",
      quickReplies: [{ title: "*Deluxe Cottage Room*", payload: "opt_0" }],
    });
    expect(bodyOf().message.quick_replies[0].title).toBe("Deluxe Cottage Room");
  });

  it("button template: body and every button title plain; payloads byte-identical", async () => {
    await sendInstagramButtonTemplate({
      toPhone: "996345286534670", hotelId: "hotel_1",
      text: "*Total: ₹24,000*\n_Note: Children above 12 years are charged as adults._",
      buttons: [
        { title: "*✅ Confirm*", payload: "CONFIRM_BOOKING" },
        { title: "_Modify_", payload: ODD_ID },
      ],
    });
    const p = bodyOf().message.attachment.payload;
    expect(p.text).toBe("Total: ₹24,000\nNote: Children above 12 years are charged as adults.");
    expect(p.buttons.map((b: any) => b.title)).toEqual(["✅ Confirm", "Modify"]);
    expect(p.buttons.map((b: any) => b.payload)).toEqual(["CONFIRM_BOOKING", ODD_ID]);
    expect([p.text, ...p.buttons.map((b: any) => b.title)].every(isPlain)).toBe(true);
  });

  it("generic template: title, subtitle and button titles plain; payloads and image_url untouched", async () => {
    await sendInstagramGenericTemplate({
      toPhone: "996345286534670", hotelId: "hotel_1",
      elements: [{
        title: "*Deluxe Cottage*",
        subtitle: "₹5,000/night — _Sea view_",
        imageUrl: "https://media.vaketta.com/rooms/*a_b_*.jpg",
        buttons: [
          { title: "*Choose*", payload: ROOM_ID },
          { title: "View Photos", payload: ODD_ID },
        ],
      }],
    });
    const el = bodyOf().message.attachment.payload.elements[0];
    expect(el.title).toBe("Deluxe Cottage");
    expect(el.subtitle).toBe("₹5,000/night — Sea view");
    expect(el.image_url).toBe("https://media.vaketta.com/rooms/*a_b_*.jpg");
    expect(el.buttons.map((b: any) => b.title)).toEqual(["Choose", "View Photos"]);
    expect(el.buttons.map((b: any) => b.payload)).toEqual([ROOM_ID, ODD_ID]);
    expect([el.title, el.subtitle].every(isPlain)).toBe(true);
  });

  it("media: the media URL is never formatted", async () => {
    const url = "https://media.vaketta.com/u/_x_/*y*.jpg";
    await sendInstagramMediaMessage({ toPhone: "996345286534670", hotelId: "hotel_1", mediaType: "image", mediaUrl: url });
    expect(bodyOf().message.attachment.payload.url).toBe(url);
  });

  it("chunking uses the post-format length: ~1000 raw chars that are ≤950 plain send once", async () => {
    const raw = Array(140).fill("*bold*").join(" "); // 979 chars raw, 699 plain
    expect(raw.length).toBeGreaterThan(950);
    await sendInstagramTextMessage({ ...INPUT, text: raw });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf().message.text).toBe(Array(140).fill("bold").join(" "));
  });

  it("chunking over 950 plain chars: chunks are plain, ≤950 each, and rejoin to the plain text", async () => {
    const raw   = Array(200).fill("*word*").join(" "); // 1399 raw
    const plain = Array(200).fill("word").join(" ");   // 999 plain → 2 chunks
    await sendInstagramTextMessage({ ...INPUT, text: raw });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [c1, c2] = [bodyOf(0).message.text, bodyOf(1).message.text];
    expect(c1.length).toBeLessThanOrEqual(950);
    expect(c2.length).toBeLessThanOrEqual(950);
    expect(isPlain(c1) && isPlain(c2)).toBe(true);
    expect(`${c1} ${c2}`).toBe(plain);
  });
});
