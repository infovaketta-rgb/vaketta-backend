/**
 * Regression tests for the Instagram renderer — the capability mapping agreed in
 * the architecture review:
 *   choice → quick replies (≤13, ids verbatim, descriptions dropped, footer
 *            appended to body; >13 → unsupported so the numbered-text fallback
 *            keeps EVERY option — never truncated)
 *   buttons → button template (≤3 postbacks, body ≤640 → else unsupported)
 *   cards   → generic template (+ leading body text; photos_ id derivation
 *             mirrors the WhatsApp sender so reply ids match across channels)
 *   media   → attachment (image/video/audio; document unsupported; caption sent
 *             as follow-up text)
 *   template→ unsupported (WhatsApp-only concept → send_template failure edge)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendInstagramTextMessage     = vi.fn();
const sendInstagramQuickReplies    = vi.fn();
const sendInstagramButtonTemplate  = vi.fn();
const sendInstagramGenericTemplate = vi.fn();
const sendInstagramMediaMessage    = vi.fn();
vi.mock("../instagram.send.service", () => ({
  sendInstagramTextMessage:     (...a: any[]) => sendInstagramTextMessage(...a),
  sendInstagramQuickReplies:    (...a: any[]) => sendInstagramQuickReplies(...a),
  sendInstagramButtonTemplate:  (...a: any[]) => sendInstagramButtonTemplate(...a),
  sendInstagramGenericTemplate: (...a: any[]) => sendInstagramGenericTemplate(...a),
  sendInstagramMediaMessage:    (...a: any[]) => sendInstagramMediaMessage(...a),
}));

import { renderInstagram, IG_QUICK_REPLY_MAX } from "./instagram.renderer";

const CTX = {
  hotelId:    "h1",
  guestId:    "g1",
  hotelPhone: "919746372102",
  guestPhone: "996345286534670", // guest IGSID
  hotelConfig: { instagramAccessTokenEncrypted: "enc" },
};

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `opt_${i}`, title: `Option ${i}`, description: `desc ${i}` }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INSTAGRAM_OUTBOUND_ENABLED", "true");
  vi.stubEnv("MOCK_INSTAGRAM_SEND", "false");
  sendInstagramTextMessage.mockResolvedValue({ message_id: "mid.txt" });
  sendInstagramQuickReplies.mockResolvedValue({ message_id: "mid.qr" });
  sendInstagramButtonTemplate.mockResolvedValue({ message_id: "mid.btn" });
  sendInstagramGenericTemplate.mockResolvedValue({ message_id: "mid.gen" });
  sendInstagramMediaMessage.mockResolvedValue({ message_id: "mid.med" });
});
afterEach(() => vi.unstubAllEnvs());

describe("choice → quick replies", () => {
  it("flattens sections to quick replies with payload ids VERBATIM, footer appended to body", async () => {
    const out = await renderInstagram(CTX, {
      kind: "choice", bodyText: "Pick one:", buttonLabel: "View Options",
      footerText: "Type 'Hi' to cancel",
      sections: [
        { title: "A", rows: [{ id: "opt_0", title: "First", description: "d" }] },
        { title: "B", rows: [{ id: "MOD_REMOVE_ROOM", title: "Remove this room" }] },
      ],
    });
    expect(out).toEqual({ ok: true, providerMessageId: "mid.qr" });
    expect(sendInstagramQuickReplies).toHaveBeenCalledWith({
      toPhone: "996345286534670",
      hotelId: "h1",
      text:    "Pick one:\n\nType 'Hi' to cancel",
      quickReplies: [
        { title: "First",            payload: "opt_0" },
        { title: "Remove this room", payload: "MOD_REMOVE_ROOM" },
      ],
    });
  });

  it(`>${IG_QUICK_REPLY_MAX} options → unsupported (text fallback keeps every option, no truncation)`, async () => {
    const out = await renderInstagram(CTX, {
      kind: "choice", bodyText: "x", buttonLabel: "V",
      sections: [{ title: "S", rows: rows(IG_QUICK_REPLY_MAX + 1) }],
    });
    expect(out).toEqual({ ok: false, reason: "unsupported" });
    expect(sendInstagramQuickReplies).not.toHaveBeenCalled();
  });

  it(`exactly ${IG_QUICK_REPLY_MAX} options is allowed`, async () => {
    const out = await renderInstagram(CTX, {
      kind: "choice", bodyText: "x", buttonLabel: "V",
      sections: [{ title: "S", rows: rows(IG_QUICK_REPLY_MAX) }],
    });
    expect(out.ok).toBe(true);
  });
});

describe("buttons → button template", () => {
  it("maps up to 3 buttons to postbacks with ids verbatim", async () => {
    const out = await renderInstagram(CTX, {
      kind: "buttons", bodyText: "Confirm?",
      buttons: [
        { id: "CONFIRM_BOOKING", title: "✅ Confirm" },
        { id: "MODIFY_BOOKING",  title: "✏️ Modify" },
        { id: "CANCEL_BOOKING",  title: "✖️ Cancel" },
      ],
    });
    expect(out).toEqual({ ok: true, providerMessageId: "mid.btn" });
    expect(sendInstagramButtonTemplate).toHaveBeenCalledWith({
      toPhone: "996345286534670", hotelId: "h1", text: "Confirm?",
      buttons: [
        { title: "✅ Confirm", payload: "CONFIRM_BOOKING" },
        { title: "✏️ Modify",  payload: "MODIFY_BOOKING" },
        { title: "✖️ Cancel",  payload: "CANCEL_BOOKING" },
      ],
    });
  });

  it("body over 640 chars → unsupported (fallback keeps the full body)", async () => {
    const out = await renderInstagram(CTX, {
      kind: "buttons", bodyText: "x".repeat(641), buttons: [{ id: "a", title: "A" }],
    });
    expect(out).toEqual({ ok: false, reason: "unsupported" });
  });

  it("more than 3 buttons → unsupported (no silent truncation)", async () => {
    const out = await renderInstagram(CTX, {
      kind: "buttons", bodyText: "x",
      buttons: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" }],
    });
    expect(out).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("cards → generic template", () => {
  it("sends body text first, then elements with Select + View Photos postbacks (WA-identical ids)", async () => {
    const out = await renderInstagram(CTX, {
      kind: "cards", bodyText: "🏨 *Choose a room type:*",
      cards: [{
        imageUrl: "https://r2/deluxe.jpg", title: "Deluxe", price: 5000,
        description: "Sea view", buttonId: "room_rt1", buttonLabel: "Choose",
      }],
    });
    expect(out).toEqual({ ok: true, providerMessageId: "mid.gen" });

    expect(sendInstagramTextMessage).toHaveBeenCalledWith({
      toPhone: "996345286534670", text: "🏨 *Choose a room type:*", hotelId: "h1",
    });
    expect(sendInstagramGenericTemplate).toHaveBeenCalledWith({
      toPhone: "996345286534670", hotelId: "h1",
      elements: [{
        title:    "Deluxe",
        subtitle: "₹5,000/night — Sea view",
        imageUrl: "https://r2/deluxe.jpg",
        buttons: [
          { title: "Choose",      payload: "room_rt1" },
          { title: "View Photos", payload: "photos_rt1" }, // same derivation as the WA sender
        ],
      }],
    });
  });
});

describe("media", () => {
  it("image sends an attachment; caption follows as text (IG has no caption surface)", async () => {
    const out = await renderInstagram(CTX, {
      kind: "media", messageType: "image", mediaUrl: "https://r2/x.jpg", mimeType: "image/jpeg", caption: "Pool view",
    });
    expect(out).toEqual({ ok: true, providerMessageId: "mid.med" });
    expect(sendInstagramMediaMessage).toHaveBeenCalledWith({
      toPhone: "996345286534670", hotelId: "h1", mediaType: "image", mediaUrl: "https://r2/x.jpg",
    });
    expect(sendInstagramTextMessage).toHaveBeenCalledWith({
      toPhone: "996345286534670", text: "Pool view", hotelId: "h1",
    });
  });

  it("document → unsupported", async () => {
    const out = await renderInstagram(CTX, {
      kind: "media", messageType: "document", mediaUrl: "https://r2/x.pdf", mimeType: "application/pdf",
    });
    expect(out).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("gates", () => {
  it("template kind is always unsupported on Instagram (send_template failure edge)", async () => {
    const out = await renderInstagram(CTX, { kind: "template", templateId: "t", values: {} });
    expect(out).toEqual({ ok: false, reason: "unsupported" });
  });

  it("INSTAGRAM_OUTBOUND_ENABLED not 'true' → disabled, zero sender calls (non-text kinds)", async () => {
    vi.stubEnv("INSTAGRAM_OUTBOUND_ENABLED", "false");
    const out = await renderInstagram(CTX, { kind: "choice", bodyText: "x", buttonLabel: "V", sections: [{ title: "S", rows: rows(2) }] });
    expect(out).toEqual({ ok: false, reason: "disabled" });
    expect(sendInstagramQuickReplies).not.toHaveBeenCalled();
  });

  it("MOCK_INSTAGRAM_SEND=true → interactive kinds fall back (parity with the WA renderer)", async () => {
    vi.stubEnv("MOCK_INSTAGRAM_SEND", "true");
    const out = await renderInstagram(CTX, { kind: "choice", bodyText: "x", buttonLabel: "V", sections: [{ title: "S", rows: rows(2) }] });
    expect(out).toEqual({ ok: false, reason: "mock" });
  });
});
