/**
 * Regression tests for processInstagramInboundEvent — echo handling + non-retryable
 * hotel resolution.
 *
 * Root cause guarded here: when TWO Instagram professional accounts are subscribed
 * to the same Meta app, one DM produces two webhook events — a normal inbound on
 * the receiver's subscription AND an is_echo event on the sender's subscription.
 * Echo events flip the ID roles (sender = business, recipient = the guest's
 * account-scoped IGSID), so running them through the inbound flow resolved the
 * hotel by a guest IGSID, threw "Hotel not found", burned 3 BullMQ retries, and
 * wrote 3 dead letters per message.
 *
 * Contract locked in:
 *  - is_echo → resolve hotel by SENDER, persist as OUTBOUND via the shared echo
 *    persister (staff replies typed in the Instagram app appear in Vaketta)
 *  - unknown echo sender / unknown inbound recipient → skip WITHOUT throwing
 *    (the worker marks the WebhookEvent processed; no retries, no dead letters)
 *  - normal inbound flow is byte-for-byte what it was before
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const logIncomingMessage    = vi.fn().mockResolvedValue({});
const resolveHotelByChannel = vi.fn();
vi.mock("./message.service", () => ({
  logIncomingMessage:    (...a: any[]) => logIncomingMessage(...a),
  resolveHotelByChannel: (...a: any[]) => resolveHotelByChannel(...a),
}));

const persistEchoedOutboundMessage = vi.fn().mockResolvedValue({ message: { id: "m1" }, isNew: true });
vi.mock("./echoPersist.service", () => ({
  persistEchoedOutboundMessage: (...a: any[]) => persistEchoedOutboundMessage(...a),
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));
vi.mock("../utils/encryption.utils", () => ({
  encryptInstagramToken: vi.fn(),
  decryptInstagramToken: vi.fn(),
}));

import { processInstagramInboundEvent } from "./instagram.service";

const HOTEL = { id: "hotel_1", phone: "919746372102", config: {} };

// Real shapes captured from Meta webhook payloads during the investigation.
function inboundEvent(overrides: any = {}) {
  return {
    sender:    { id: "996345286534670" },        // guest IGSID
    recipient: { id: "17841443797859809" },      // connected business account
    message:   { mid: "mid.INBOUND1", text: "Hi" },
    timestamp: 1785012185941,
    ...overrides,
  };
}

function echoEvent(overrides: any = {}) {
  return {
    sender:    { id: "17841443797859809" },      // business account (it sent the message)
    recipient: { id: "996345286534670" },        // guest IGSID in the business's scope
    message:   { mid: "mid.ECHO1", text: "Thanks, see you soon!", is_echo: true },
    timestamp: 1785012185941,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  logIncomingMessage.mockResolvedValue({});
  persistEchoedOutboundMessage.mockResolvedValue({ message: { id: "m1" }, isNew: true });
});

describe("normal inbound Instagram message (behaviour preserved)", () => {
  it("resolves the hotel by recipient and delegates to the shared inbound pipeline", async () => {
    resolveHotelByChannel.mockResolvedValue(HOTEL);

    await processInstagramInboundEvent(inboundEvent());

    expect(resolveHotelByChannel).toHaveBeenCalledWith("INSTAGRAM", "17841443797859809");
    expect(logIncomingMessage).toHaveBeenCalledTimes(1);
    expect(logIncomingMessage).toHaveBeenCalledWith({
      fromPhone:   "996345286534670",
      toPhone:     "17841443797859809",
      body:        "Hi",
      messageType: "text",
      wamid:       "mid.INBOUND1",
      channel:     "INSTAGRAM",
    });
    // Inbound never goes through the echo persister
    expect(persistEchoedOutboundMessage).not.toHaveBeenCalled();
  });

  it("unknown hotel: skips WITHOUT throwing so the job is never retried", async () => {
    resolveHotelByChannel.mockResolvedValue(null);

    await expect(processInstagramInboundEvent(inboundEvent())).resolves.toBeUndefined();

    expect(logIncomingMessage).not.toHaveBeenCalled();
    expect(persistEchoedOutboundMessage).not.toHaveBeenCalled();
  });

  it("ignores events without sender/recipient/mid", async () => {
    await processInstagramInboundEvent({ sender: { id: "x" } });
    expect(resolveHotelByChannel).not.toHaveBeenCalled();
    expect(logIncomingMessage).not.toHaveBeenCalled();
  });
});

describe("Instagram echo events (staff replies from the Instagram app)", () => {
  it("resolves the hotel by SENDER and stores the message as OUTBOUND", async () => {
    resolveHotelByChannel.mockResolvedValue(HOTEL);

    await processInstagramInboundEvent(echoEvent());

    // Echo → business is the sender, so resolution flips to sender.id
    expect(resolveHotelByChannel).toHaveBeenCalledWith("INSTAGRAM", "17841443797859809");
    expect(persistEchoedOutboundMessage).toHaveBeenCalledTimes(1);
    expect(persistEchoedOutboundMessage).toHaveBeenCalledWith({
      hotelId:     "hotel_1",
      fromPhone:   "919746372102",       // same business-side identifier as Vaketta-sent replies
      guestPhone:  "996345286534670",    // guest IGSID — the thread it lands in
      body:        "Thanks, see you soon!",
      messageType: "text",
      wamid:       "mid.ECHO1",          // dedup key — (hotelId, wamid) unique constraint
      channel:     "INSTAGRAM",
    });
    // Echoes NEVER run the inbound pipeline (no bot, no usage, no push)
    expect(logIncomingMessage).not.toHaveBeenCalled();
  });

  it("unknown echo account (second subscribed IG account): skipped without retry", async () => {
    resolveHotelByChannel.mockResolvedValue(null);

    // The exact production payload shape that used to throw "Hotel not found"
    const foreignEcho = echoEvent({
      sender:    { id: "17841479584232252" },   // other professional account
      recipient: { id: "1521144729614767" },    // hotel's IGSID in THAT account's scope
    });

    await expect(processInstagramInboundEvent(foreignEcho)).resolves.toBeUndefined();

    expect(resolveHotelByChannel).toHaveBeenCalledWith("INSTAGRAM", "17841479584232252");
    expect(persistEchoedOutboundMessage).not.toHaveBeenCalled();
    expect(logIncomingMessage).not.toHaveBeenCalled();
  });

  it("attachment-only echo (no text): skipped without persisting", async () => {
    resolveHotelByChannel.mockResolvedValue(HOTEL);

    await processInstagramInboundEvent(
      echoEvent({ message: { mid: "mid.ECHO2", is_echo: true, attachments: [{ type: "ig_reel" }] } }),
    );

    expect(persistEchoedOutboundMessage).not.toHaveBeenCalled();
    expect(logIncomingMessage).not.toHaveBeenCalled();
  });
});

describe("interactive reply normalization (quick replies + postbacks)", () => {
  beforeEach(() => resolveHotelByChannel.mockResolvedValue(HOTEL));

  it("quick-reply tap: body = tapped title, botBody = payload id, metadata = quick_reply", async () => {
    await processInstagramInboundEvent(inboundEvent({
      message: { mid: "mid.QR1", text: "First option", quick_reply: { payload: "opt_0" } },
    }));

    expect(logIncomingMessage).toHaveBeenCalledWith({
      fromPhone:   "996345286534670",
      toPhone:     "17841443797859809",
      body:        "First option",   // human-readable title in the chat bubble
      messageType: "text",
      wamid:       "mid.QR1",
      channel:     "INSTAGRAM",
      botBody:     "opt_0",          // what the flow engine matches on
      metadata:    { interactiveReply: { type: "quick_reply", id: "opt_0", title: "First option", description: null } },
    });
  });

  it("postback tap (button/generic template): mid from event.postback, body = title, botBody = payload", async () => {
    await processInstagramInboundEvent(inboundEvent({
      message: undefined,
      postback: { mid: "mid.PB1", title: "Choose", payload: "room_rt1" },
    }));

    expect(logIncomingMessage).toHaveBeenCalledWith({
      fromPhone:   "996345286534670",
      toPhone:     "17841443797859809",
      body:        "Choose",
      messageType: "text",
      wamid:       "mid.PB1",
      channel:     "INSTAGRAM",
      botBody:     "room_rt1",
      metadata:    { interactiveReply: { type: "button_reply", id: "room_rt1", title: "Choose", description: null } },
    });
  });

  it("plain text message stays byte-identical (no botBody/metadata keys added)", async () => {
    await processInstagramInboundEvent(inboundEvent());

    expect(logIncomingMessage).toHaveBeenCalledWith({
      fromPhone:   "996345286534670",
      toPhone:     "17841443797859809",
      body:        "Hi",
      messageType: "text",
      wamid:       "mid.INBOUND1",
      channel:     "INSTAGRAM",
    });
  });
});
