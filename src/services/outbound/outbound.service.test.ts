/**
 * Regression tests for sendOutbound — the single outbound dispatch pipeline.
 *
 * Locks in the contract every migrated call site relies on:
 *  - renderer selected by ctx.channel (the ONLY channel branch)
 *  - Message row persisted ONLY after a successful send, with channel-neutral
 *    messageType/metadata derived from the LOGICAL payload (identical rows for
 *    WhatsApp and Instagram sends of the same interaction)
 *  - selfPersisted renderers (WA templates) skip the pipeline persist
 *  - persist:false skips persistence (show_rooms photo bursts)
 *  - renderer throw → { sent:false } — never throws to the flow engine
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const hotelFindUnique = vi.fn();
const guestFindUnique = vi.fn();
const messageCreate   = vi.fn();
vi.mock("../../db/connect", () => ({
  default: {
    hotel:   { findUnique: (...a: any[]) => hotelFindUnique(...a) },
    guest:   { findUnique: (...a: any[]) => guestFindUnique(...a) },
    message: { create:     (...a: any[]) => messageCreate(...a) },
  },
}));

const renderWhatsApp  = vi.fn();
const renderInstagram = vi.fn();
vi.mock("./whatsapp.renderer",  () => ({ renderWhatsApp:  (...a: any[]) => renderWhatsApp(...a) }));
vi.mock("./instagram.renderer", () => ({ renderInstagram: (...a: any[]) => renderInstagram(...a) }));

const emitToHotel = vi.fn();
vi.mock("../../realtime/emit", () => ({ emitToHotel: (...a: any[]) => emitToHotel(...a) }));
vi.mock("../../utils/logger", () => ({
  logger: { child: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import { sendOutbound } from "./outbound.service";
import { buildListMetadata, buildButtonsMetadata } from "../interactiveReply.service";

const WA_CTX = { hotelId: "h1", guestId: "g1", channel: "WHATSAPP" as any };
const IG_CTX = { hotelId: "h1", guestId: "g1", channel: "INSTAGRAM" as any };

const CHOICE = {
  kind:        "choice" as const,
  bodyText:    "Pick one:",
  buttonLabel: "View Options",
  sections:    [{ title: "Options", rows: [{ id: "opt_0", title: "First" }, { id: "opt_1", title: "Second" }] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  hotelFindUnique.mockResolvedValue({ id: "h1", phone: "H_PHONE", config: { metaPhoneNumberId: "PN" } });
  guestFindUnique.mockResolvedValue({ phone: "G_PHONE" });
  messageCreate.mockImplementation(async (arg: any) => ({ id: "m1", ...arg.data }));
  renderWhatsApp.mockResolvedValue({ ok: true, providerMessageId: "wamid.1" });
  renderInstagram.mockResolvedValue({ ok: true, providerMessageId: "mid.1" });
});

describe("renderer selection", () => {
  it("routes WHATSAPP to the WhatsApp renderer with resolved contact info", async () => {
    await sendOutbound(WA_CTX, CHOICE);
    expect(renderWhatsApp).toHaveBeenCalledTimes(1);
    expect(renderInstagram).not.toHaveBeenCalled();
    const [ctx, payload] = renderWhatsApp.mock.calls[0]!;
    expect(ctx).toMatchObject({ hotelId: "h1", guestId: "g1", hotelPhone: "H_PHONE", guestPhone: "G_PHONE" });
    expect(ctx.hotelConfig).toEqual({ metaPhoneNumberId: "PN" });
    expect(payload).toBe(CHOICE);
  });

  it("routes INSTAGRAM to the Instagram renderer", async () => {
    await sendOutbound(IG_CTX, CHOICE);
    expect(renderInstagram).toHaveBeenCalledTimes(1);
    expect(renderWhatsApp).not.toHaveBeenCalled();
  });
});

describe("persistence — channel-neutral rows", () => {
  it("choice → messageType 'list' + list metadata, channel from ctx", async () => {
    const res = await sendOutbound(IG_CTX, CHOICE);
    expect(res).toEqual({ sent: true, messageId: "mid.1" });

    expect(messageCreate).toHaveBeenCalledTimes(1);
    const data = messageCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      direction:   "OUT",
      fromPhone:   "H_PHONE",
      toPhone:     "G_PHONE",
      body:        "Pick one:",
      messageType: "list",
      channel:     "INSTAGRAM",   // ctx channel — never hardcoded WHATSAPP
      status:      "SENT",
      wamid:       "mid.1",
    });
    expect(data.metadata).toEqual(buildListMetadata("View Options", CHOICE.sections));
    expect(emitToHotel).toHaveBeenCalledWith("h1", "message:new", { message: expect.objectContaining({ id: "m1" }) });
  });

  it("buttons → messageType 'button' + buttons metadata", async () => {
    const buttons = [{ id: "CONFIRM_BOOKING", title: "✅ Confirm" }];
    await sendOutbound(WA_CTX, { kind: "buttons", bodyText: "Sure?", buttons });
    const data = messageCreate.mock.calls[0]![0].data;
    expect(data.messageType).toBe("button");
    expect(data.metadata).toEqual(buildButtonsMetadata(buttons));
  });

  it("cards → messageType 'carousel' with {cards} JSON body (RoomCarouselBubble contract)", async () => {
    const cards = [{ imageUrl: "u", title: "Deluxe", price: 5000, description: "d", buttonId: "room_1" }];
    await sendOutbound(WA_CTX, { kind: "cards", bodyText: "Choose:", cards });
    const data = messageCreate.mock.calls[0]![0].data;
    expect(data.messageType).toBe("carousel");
    expect(JSON.parse(data.body)).toEqual({ cards });
    expect(data.metadata).toBeUndefined();
  });

  it("media → media columns persisted; text row when caption present", async () => {
    await sendOutbound(WA_CTX, { kind: "media", messageType: "image", mediaUrl: "https://r2/x.jpg", mimeType: "image/jpeg", caption: "Pool view" });
    const data = messageCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({ messageType: "image", mediaUrl: "https://r2/x.jpg", mimeType: "image/jpeg", body: "Pool view" });
  });

  it("no wamid field when the renderer returns a null provider id (mock-mode text)", async () => {
    renderWhatsApp.mockResolvedValue({ ok: true, providerMessageId: null });
    await sendOutbound(WA_CTX, { kind: "text", text: "hello" });
    const data = messageCreate.mock.calls[0]![0].data;
    expect(data).not.toHaveProperty("wamid");
    expect(data.body).toBe("hello");
    expect(data.messageType).toBe("text");
  });
});

describe("non-send outcomes", () => {
  it("renderer not-ok → sent:false with reason, NO persist, NO emit", async () => {
    renderWhatsApp.mockResolvedValue({ ok: false, reason: "no_credentials" });
    const res = await sendOutbound(WA_CTX, CHOICE);
    expect(res).toEqual({ sent: false, reason: "no_credentials" });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(emitToHotel).not.toHaveBeenCalled();
  });

  it("renderer throw → sent:false 'send_failed', never throws", async () => {
    renderWhatsApp.mockRejectedValue(new Error("Meta 500"));
    await expect(sendOutbound(WA_CTX, CHOICE)).resolves.toEqual({ sent: false, reason: "send_failed" });
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("missing hotel or guest → 'no_contact', renderer never called", async () => {
    guestFindUnique.mockResolvedValue(null);
    const res = await sendOutbound(WA_CTX, CHOICE);
    expect(res).toEqual({ sent: false, reason: "no_contact" });
    expect(renderWhatsApp).not.toHaveBeenCalled();
  });
});

describe("persist bypass", () => {
  it("selfPersisted renderer result (WA templates) skips pipeline persist + emit", async () => {
    renderWhatsApp.mockResolvedValue({ ok: true, providerMessageId: "wamid.tpl", selfPersisted: true });
    const res = await sendOutbound(WA_CTX, { kind: "template", templateId: "t1", values: {} });
    expect(res).toEqual({ sent: true, messageId: "wamid.tpl" });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(emitToHotel).not.toHaveBeenCalled();
  });

  it("persist:false sends without persisting (show_rooms photo bursts)", async () => {
    const res = await sendOutbound(
      WA_CTX,
      { kind: "media", messageType: "image", mediaUrl: "https://r2/x.jpg", mimeType: "image/jpeg" },
      { persist: false },
    );
    expect(res.sent).toBe(true);
    expect(messageCreate).not.toHaveBeenCalled();
    expect(emitToHotel).not.toHaveBeenCalled();
  });
});
