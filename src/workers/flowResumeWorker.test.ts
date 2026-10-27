/**
 * flowResumeWorker — resumed (delayed) flows must go out over the guest's own
 * channel. The worker used to call the WhatsApp sender directly and run the
 * flow step with no channel, so an Instagram guest's resumed flow was sent to
 * the WhatsApp API with an Instagram user id.
 *
 * Real modules on the routing path: channel.send.service (picks the sender) and
 * guestChannel.service (derives the channel from the latest message), each
 * wrapped in a pass-through spy. Mocked: bullmq (to capture the processor),
 * prisma, redis, logger, flowRuntime, session.service and the two raw senders.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageChannel } from "@prisma/client";

const m = vi.hoisted(() => ({
  processor:        null as null | ((job: any) => Promise<void>),
  pausedFindUnique: vi.fn(),
  pausedDelete:     vi.fn(),
  messageFindFirst: vi.fn(),
  deadLetterCreate: vi.fn(),
  executeFlowStep:  vi.fn(),
  updateSession:    vi.fn(),
  sendTextMessage:  vi.fn(),   // WhatsApp sender
  sendInstagram:    vi.fn(),   // Instagram sender
}));

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(_name: string, processor: any) { m.processor = processor; }
    on() { return this; }
  },
}));
vi.mock("../db/connect", () => ({
  default: {
    pausedFlow:      { findUnique: (...a: any[]) => m.pausedFindUnique(...a), delete: (...a: any[]) => m.pausedDelete(...a) },
    message:         { findFirst:  (...a: any[]) => m.messageFindFirst(...a) },
    deadLetterEvent: { create:     (...a: any[]) => m.deadLetterCreate(...a) },
  },
}));
vi.mock("../queue/redis", () => ({ redis: {} }));
vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("../automation/flowRuntime", () => ({
  executeFlowStep: (...a: any[]) => m.executeFlowStep(...a),
}));
vi.mock("../services/session.service", () => ({
  updateSession: (...a: any[]) => m.updateSession(...a),
}));
vi.mock("../services/whatsapp.send.service", () => ({
  sendTextMessage: (...a: any[]) => m.sendTextMessage(...a),
}));
vi.mock("../services/instagram.send.service", () => ({
  sendInstagramTextMessage: (...a: any[]) => m.sendInstagram(...a),
}));
// Pass-through spies over the REAL modules.
vi.mock("../services/channel.send.service", async (orig) => {
  const real = await orig<typeof import("../services/channel.send.service")>();
  return { sendChannelMessage: vi.fn(real.sendChannelMessage) };
});
vi.mock("../services/guestChannel.service", async (orig) => {
  const real = await orig<typeof import("../services/guestChannel.service")>();
  return { getGuestChannel: vi.fn(real.getGuestChannel) };
});

import "./flowResumeWorker";
import { sendChannelMessage } from "../services/channel.send.service";
import { getGuestChannel } from "../services/guestChannel.service";

const APOLOGY = "Sorry, we encountered an issue resuming your conversation. Please try again by sending a message.";

const PAUSED = {
  id: "pf_1", flowId: "flow_1", nodeId: "node_9",
  flowVars: { guestName: "Asha" },
  guestId: "guest_1", hotelId: "hotel_1",
  guest: { phone: "996345286534670" },
  hotel: { phone: "919876543210" },
};

const run = () => m.processor!({ data: { pausedFlowId: "pf_1" } });
const lastMessageOn = (channel: MessageChannel | null) =>
  m.messageFindFirst.mockResolvedValue(channel ? { channel } : null);

beforeEach(() => {
  vi.clearAllMocks();
  m.pausedFindUnique.mockResolvedValue(PAUSED);
  m.pausedDelete.mockResolvedValue({});
  m.updateSession.mockResolvedValue(undefined);
  m.executeFlowStep.mockResolvedValue("Your table is ready 🍽");
  m.sendTextMessage.mockResolvedValue({ messages: [{ id: "wamid.1" }] });
  m.sendInstagram.mockResolvedValue({ message_id: "mid.1" });
});

describe("flowResumeWorker — sends via the guest's channel", () => {
  it("FR1: Instagram guest — flow step gets INSTAGRAM, reply goes via the Instagram sender, WhatsApp never called", async () => {
    lastMessageOn(MessageChannel.INSTAGRAM);
    await run();

    expect(m.executeFlowStep).toHaveBeenCalledWith(
      "hotel_1", "guest_1", "FLOW:flow_1:node_9",
      { flow: { flowId: "flow_1", flowVars: { guestName: "Asha" } } },
      "", MessageChannel.INSTAGRAM,
    );
    expect(sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: MessageChannel.INSTAGRAM, text: "Your table is ready 🍽",
    }));
    expect(m.sendInstagram).toHaveBeenCalledWith({
      toPhone: "996345286534670", text: "Your table is ready 🍽", hotelId: "hotel_1",
    });
    expect(m.sendTextMessage).not.toHaveBeenCalled();
  });

  it("FR2: WhatsApp guest — flow step gets WHATSAPP, and the WhatsApp send is identical to before", async () => {
    lastMessageOn(MessageChannel.WHATSAPP);
    await run();

    expect(m.executeFlowStep.mock.calls[0]![5]).toBe(MessageChannel.WHATSAPP);
    // Exactly the argument object the old worker passed to sendTextMessage.
    expect(m.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(m.sendTextMessage).toHaveBeenCalledWith({
      toPhone: "996345286534670", fromPhone: "919876543210",
      hotelId: "hotel_1", guestId: "guest_1", text: "Your table is ready 🍽",
    });
    expect(m.sendInstagram).not.toHaveBeenCalled();
  });

  it("FR3: the apology on a failed resume also uses the guest's channel", async () => {
    lastMessageOn(MessageChannel.INSTAGRAM);
    m.executeFlowStep.mockRejectedValue(new Error("flow exploded"));
    await run();

    expect(m.sendInstagram).toHaveBeenCalledTimes(1);
    expect(m.sendInstagram).toHaveBeenCalledWith({ toPhone: "996345286534670", text: APOLOGY, hotelId: "hotel_1" });
    expect(m.sendTextMessage).not.toHaveBeenCalled();
  });

  it("FR3b: WhatsApp apology is unchanged", async () => {
    lastMessageOn(MessageChannel.WHATSAPP);
    m.executeFlowStep.mockRejectedValue(new Error("flow exploded"));
    await run();

    expect(m.sendTextMessage).toHaveBeenCalledWith({
      toPhone: "996345286534670", fromPhone: "919876543210",
      hotelId: "hotel_1", guestId: "guest_1", text: APOLOGY,
    });
  });

  it("FR4: a guest with no message history falls back to WHATSAPP", async () => {
    lastMessageOn(null);
    await run();

    expect(m.executeFlowStep.mock.calls[0]![5]).toBe(MessageChannel.WHATSAPP);
    expect(m.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(m.sendInstagram).not.toHaveBeenCalled();
  });

  it("FR5: the channel is looked up once per job, even when the reply AND the apology are both sent", async () => {
    lastMessageOn(MessageChannel.INSTAGRAM);
    m.sendInstagram.mockRejectedValueOnce(new Error("Meta 500")).mockResolvedValueOnce({ message_id: "mid.2" });
    await run();

    expect(m.sendInstagram).toHaveBeenCalledTimes(2);             // reply failed, apology sent
    expect(m.sendInstagram.mock.calls[1]![0].text).toBe(APOLOGY);
    expect(getGuestChannel).toHaveBeenCalledTimes(1);
    expect(getGuestChannel).toHaveBeenCalledWith("guest_1", "hotel_1");
    expect(m.messageFindFirst).toHaveBeenCalledTimes(1);
  });

  it("FR6: if the channel lookup itself fails, the job still completes and apologises over WhatsApp", async () => {
    m.messageFindFirst.mockRejectedValue(new Error("db down"));
    await expect(run()).resolves.toBeUndefined();

    expect(m.executeFlowStep).not.toHaveBeenCalled();
    expect(m.sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ text: APOLOGY }));
    expect(m.sendInstagram).not.toHaveBeenCalled();
  });

  it("FR7: no reply → nothing is sent; a missing PausedFlow is skipped without a lookup", async () => {
    lastMessageOn(MessageChannel.INSTAGRAM);
    m.executeFlowStep.mockResolvedValue(null);
    await run();
    expect(sendChannelMessage).not.toHaveBeenCalled();

    vi.clearAllMocks();
    m.pausedFindUnique.mockResolvedValue(null);
    await run();
    expect(getGuestChannel).not.toHaveBeenCalled();
    expect(m.executeFlowStep).not.toHaveBeenCalled();
  });
});
