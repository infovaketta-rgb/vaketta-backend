/**
 * Regression tests for the WhatsApp renderer — asserts each logical payload maps
 * to EXACTLY the same whatsapp.send.service call the pre-refactor trySend*
 * helpers made (behavior-identical migration), plus the mock/credential
 * short-circuits for interactive kinds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendTextMessage     = vi.fn();
const sendMediaMessage    = vi.fn();
const sendListMessage     = vi.fn();
const sendButtonMessage   = vi.fn();
const sendCarouselMessage = vi.fn();
vi.mock("../whatsapp.send.service", () => ({
  sendTextMessage:     (...a: any[]) => sendTextMessage(...a),
  sendMediaMessage:    (...a: any[]) => sendMediaMessage(...a),
  sendListMessage:     (...a: any[]) => sendListMessage(...a),
  sendButtonMessage:   (...a: any[]) => sendButtonMessage(...a),
  sendCarouselMessage: (...a: any[]) => sendCarouselMessage(...a),
}));

const sendTemplateMessage = vi.fn();
vi.mock("../templates.service", () => ({
  sendTemplateMessage: (...a: any[]) => sendTemplateMessage(...a),
}));

vi.mock("../../utils/encryption.utils", () => ({
  decryptWhatsAppToken: vi.fn(() => "WA_TOKEN"),
}));

import { renderWhatsApp } from "./whatsapp.renderer";

const CTX = {
  hotelId:    "h1",
  guestId:    "g1",
  hotelPhone: "H_PHONE",
  guestPhone: "G_PHONE",
  hotelConfig: { metaPhoneNumberId: "PN_1", metaAccessTokenEncrypted: "enc" },
};

const SECTIONS = [{ title: "Options", rows: [{ id: "opt_0", title: "First" }] }];

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["MOCK_WHATSAPP_SEND"];
  sendListMessage.mockResolvedValue("wamid.list");
  sendButtonMessage.mockResolvedValue("wamid.btn");
  sendCarouselMessage.mockResolvedValue("wamid.car");
  sendTextMessage.mockResolvedValue({ messages: [{ id: "wamid.txt" }] });
  sendMediaMessage.mockResolvedValue({ messages: [{ id: "wamid.med" }] });
  sendTemplateMessage.mockResolvedValue({ success: true, messageId: "wamid.tpl" });
});
afterEach(() => { delete process.env["MOCK_WHATSAPP_SEND"]; });

describe("kind mapping — identical sender calls to the pre-refactor helpers", () => {
  it("choice → sendListMessage(guestPhone, phoneNumberId, token, {bodyText, buttonLabel, sections, footerText?})", async () => {
    const out = await renderWhatsApp(CTX, {
      kind: "choice", bodyText: "Pick:", buttonLabel: "View", sections: SECTIONS, footerText: "Type MENU to cancel",
    });
    expect(out).toEqual({ ok: true, providerMessageId: "wamid.list" });
    expect(sendListMessage).toHaveBeenCalledWith("G_PHONE", "PN_1", "WA_TOKEN", {
      bodyText: "Pick:", buttonLabel: "View", sections: SECTIONS, footerText: "Type MENU to cancel",
    });
  });

  it("buttons → sendButtonMessage with the ids verbatim", async () => {
    const buttons = [{ id: "CONFIRM_BOOKING", title: "✅ Confirm" }];
    const out = await renderWhatsApp(CTX, { kind: "buttons", bodyText: "OK?", buttons });
    expect(out).toEqual({ ok: true, providerMessageId: "wamid.btn" });
    expect(sendButtonMessage).toHaveBeenCalledWith("G_PHONE", "PN_1", "WA_TOKEN", { bodyText: "OK?", buttons });
  });

  it("cards → sendCarouselMessage(bodyText, cards); <2 cards is unsupported (Meta minimum)", async () => {
    const cards = [
      { imageUrl: "u1", title: "A", price: 1, description: "d", buttonId: "room_a" },
      { imageUrl: "u2", title: "B", price: 2, description: "d", buttonId: "room_b" },
    ];
    const out = await renderWhatsApp(CTX, { kind: "cards", bodyText: "Choose:", cards });
    expect(out).toEqual({ ok: true, providerMessageId: "wamid.car" });
    expect(sendCarouselMessage).toHaveBeenCalledWith("G_PHONE", "PN_1", "WA_TOKEN", "Choose:", cards);

    const single = await renderWhatsApp(CTX, { kind: "cards", bodyText: "x", cards: cards.slice(0, 1) });
    expect(single).toEqual({ ok: false, reason: "unsupported" });
  });

  it("text → sendTextMessage (no credential gate — the sender no-ops itself)", async () => {
    const out = await renderWhatsApp({ ...CTX, hotelConfig: null }, { kind: "text", text: "hello" });
    expect(out).toEqual({ ok: true, providerMessageId: "wamid.txt" });
    expect(sendTextMessage).toHaveBeenCalledWith({
      toPhone: "G_PHONE", fromPhone: "H_PHONE", hotelId: "h1", guestId: "g1", text: "hello",
    });
  });

  it("media → sendMediaMessage passthrough", async () => {
    await renderWhatsApp(CTX, { kind: "media", messageType: "image", mediaUrl: "https://r2/x.jpg", mimeType: "image/jpeg" });
    expect(sendMediaMessage).toHaveBeenCalledWith({
      toPhone: "G_PHONE", hotelId: "h1", messageType: "image",
      mediaUrl: "https://r2/x.jpg", mimeType: "image/jpeg", fileName: null, caption: null,
    });
  });

  it("template → templates.service, reported selfPersisted (it persists + emits itself)", async () => {
    const out = await renderWhatsApp(CTX, { kind: "template", templateId: "t1", values: { "1": "x" } });
    expect(out).toEqual({ ok: true, providerMessageId: "wamid.tpl", selfPersisted: true });
    expect(sendTemplateMessage).toHaveBeenCalledWith("h1", "g1", "t1", { "1": "x" });
  });
});

describe("interactive short-circuits (pre-refactor trySend* behavior)", () => {
  it("MOCK_WHATSAPP_SEND=true → interactive not sent (text fallback), but text still delegates", async () => {
    process.env["MOCK_WHATSAPP_SEND"] = "true";
    const choice = await renderWhatsApp(CTX, { kind: "choice", bodyText: "x", buttonLabel: "V", sections: SECTIONS });
    expect(choice).toEqual({ ok: false, reason: "mock" });
    expect(sendListMessage).not.toHaveBeenCalled();

    const text = await renderWhatsApp(CTX, { kind: "text", text: "hi" });
    expect(text.ok).toBe(true); // sender handles mock internally
  });

  it("missing Meta credentials → no_credentials for interactive kinds", async () => {
    const out = await renderWhatsApp({ ...CTX, hotelConfig: {} }, { kind: "choice", bodyText: "x", buttonLabel: "V", sections: SECTIONS });
    expect(out).toEqual({ ok: false, reason: "no_credentials" });
    expect(sendListMessage).not.toHaveBeenCalled();
  });
});
