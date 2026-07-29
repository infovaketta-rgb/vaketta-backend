/**
 * Regression tests for the Instagram guard in sendTemplateMessage.
 *
 * WhatsApp templates are a Meta WhatsApp Cloud API construct with no Instagram
 * equivalent, and the send path uses WhatsApp credentials against the WhatsApp
 * /messages edge. The guard must reject INSTAGRAM conversations BEFORE any Meta
 * call or DB write, while leaving WhatsApp behavior untouched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirstTemplate = vi.fn();
const findFirstGuest    = vi.fn();
const findFirstMessage  = vi.fn();
const createMessage     = vi.fn();
const findUniqueHotel   = vi.fn();
const findUniqueConfig  = vi.fn();
const findUniquePlatform = vi.fn();

vi.mock("../db/connect", () => ({
  default: {
    whatsAppTemplate: { findFirst: (...a: any[]) => findFirstTemplate(...a) },
    guest:            { findFirst: (...a: any[]) => findFirstGuest(...a) },
    message:          {
      findFirst: (...a: any[]) => findFirstMessage(...a),
      create:    (...a: any[]) => createMessage(...a),
    },
    hotel:            { findUnique: (...a: any[]) => findUniqueHotel(...a) },
    hotelConfig:      { findUnique: (...a: any[]) => findUniqueConfig(...a) },
    platformSettings: { findUnique: (...a: any[]) => findUniquePlatform(...a) },
  },
}));

vi.mock("../utils/encryption.utils", () => ({
  decryptWhatsAppToken: vi.fn(() => "WA_TOKEN"),
}));

const emitToHotel = vi.fn();
vi.mock("../realtime/emit", () => ({ emitToHotel: (...a: any[]) => emitToHotel(...a) }));

vi.mock("./whatsapp.send.service", () => ({
  withMetaRetry: async (fn: any) => fn(),
}));

import { sendTemplateMessage } from "./templates.service";

const TEMPLATE = {
  id:           "t1",
  hotelId:      "h1",
  name:         "welcome",
  language:     "en",
  status:       "APPROVED",
  headerFormat: null,
  headerHandle: null,
  components:   { body: { text: "Hi {{name}}, welcome!" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  findFirstTemplate.mockResolvedValue(TEMPLATE);
  findFirstGuest.mockResolvedValue({ id: "g1", hotelId: "h1", phone: "+15550001" });
  findUniqueHotel.mockResolvedValue({ phone: "+15559999" });
  findUniqueConfig.mockResolvedValue({
    metaWabaId: "waba1", metaAccessTokenEncrypted: "enc", metaPhoneNumberId: "PN_1",
  });
  findUniquePlatform.mockResolvedValue({ metaApiVersion: "v25.0" });
  createMessage.mockResolvedValue({ id: "m1" });
  findFirstMessage.mockResolvedValue({ channel: "WHATSAPP" });
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok:   true,
    json: async () => ({ messages: [{ id: "wamid.tpl" }] }),
  })));
});

describe("sendTemplateMessage — Instagram guard", () => {
  it("rejects an INSTAGRAM conversation with a clear message and 400", async () => {
    findFirstMessage.mockResolvedValue({ channel: "INSTAGRAM" });

    await expect(sendTemplateMessage("h1", "g1", "t1", { name: "Sam" }))
      .rejects.toMatchObject({
        status:  400,
        message: expect.stringContaining("cannot be sent to Instagram"),
      });
  });

  it("never calls Meta or persists a message when the channel is INSTAGRAM", async () => {
    findFirstMessage.mockResolvedValue({ channel: "INSTAGRAM" });

    await expect(sendTemplateMessage("h1", "g1", "t1", {})).rejects.toThrow();

    expect(fetch).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(emitToHotel).not.toHaveBeenCalled();
  });
});

describe("sendTemplateMessage — WhatsApp behavior preserved", () => {
  it("sends and persists normally for a WHATSAPP conversation", async () => {
    const result = await sendTemplateMessage("h1", "g1", "t1", { name: "Sam" });

    expect(result).toEqual({ success: true, messageId: "wamid.tpl" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(emitToHotel).toHaveBeenCalledWith("h1", "message:new", expect.anything());
  });

  it("treats a guest with no prior messages as WhatsApp (default channel)", async () => {
    findFirstMessage.mockResolvedValue(null);

    const result = await sendTemplateMessage("h1", "g1", "t1", { name: "Sam" });

    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("persists body as {renderedBody, components} JSON with variables interpolated", async () => {
    await sendTemplateMessage("h1", "g1", "t1", { name: "Sam" });

    const body = JSON.parse(createMessage.mock.calls[0]![0].data.body);
    expect(body.renderedBody).toBe("Hi Sam, welcome!");
    expect(body.components.body.text).toBe("Hi Sam, welcome!");
  });
});
