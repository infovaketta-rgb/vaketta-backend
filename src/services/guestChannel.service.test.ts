import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageChannel } from "@prisma/client";

type Row = { guestId: string; hotelId: string; channel: MessageChannel; timestamp: Date };

// In-memory stand-in for prisma.message.findFirst that HONOURS the query it is
// given (where / orderBy timestamp / select), so "most recent wins" is decided
// by the service's own query, not by a canned return value.
let rows: Row[] = [];
const findFirst = vi.fn(async (args: any) => {
  const { where, orderBy, select } = args;
  const dir = orderBy?.timestamp === "desc" ? -1 : 1;
  const hit = rows
    .filter((r) => r.guestId === where.guestId && r.hotelId === where.hotelId)
    .sort((a, b) => dir * (a.timestamp.getTime() - b.timestamp.getTime()))[0];
  if (!hit) return null;
  return select?.channel ? { channel: hit.channel } : hit;
});

vi.mock("../db/connect", () => ({
  default: { message: { findFirst: (...a: any[]) => findFirst(...(a as [any])) } },
}));

import { getGuestChannel } from "./guestChannel.service";

const msg = (channel: MessageChannel, minutesAgo: number, guestId = "g1", hotelId = "h1"): Row => ({
  guestId, hotelId, channel, timestamp: new Date(Date.now() - minutesAgo * 60_000),
});

beforeEach(() => {
  rows = [];
  findFirst.mockClear();
});

describe("getGuestChannel", () => {
  it("latest message INSTAGRAM → INSTAGRAM", async () => {
    rows = [msg(MessageChannel.INSTAGRAM, 1)];
    expect(await getGuestChannel("g1", "h1")).toBe(MessageChannel.INSTAGRAM);
  });

  it("latest message WHATSAPP → WHATSAPP", async () => {
    rows = [msg(MessageChannel.WHATSAPP, 1)];
    expect(await getGuestChannel("g1", "h1")).toBe(MessageChannel.WHATSAPP);
  });

  it("mixed history: the most recent message wins, whatever the insertion order", async () => {
    rows = [msg(MessageChannel.INSTAGRAM, 1), msg(MessageChannel.WHATSAPP, 60)];
    expect(await getGuestChannel("g1", "h1")).toBe(MessageChannel.INSTAGRAM);

    rows = [msg(MessageChannel.INSTAGRAM, 60), msg(MessageChannel.WHATSAPP, 1)];
    expect(await getGuestChannel("g1", "h1")).toBe(MessageChannel.WHATSAPP);
  });

  it("no messages → WHATSAPP", async () => {
    expect(await getGuestChannel("g1", "h1")).toBe(MessageChannel.WHATSAPP);
  });

  it("is scoped to this guest AND hotel — another guest's or hotel's messages never count", async () => {
    rows = [
      msg(MessageChannel.INSTAGRAM, 1, "g2", "h1"),
      msg(MessageChannel.INSTAGRAM, 1, "g1", "h2"),
      msg(MessageChannel.WHATSAPP, 30, "g1", "h1"),
    ];
    expect(await getGuestChannel("g1", "h1")).toBe(MessageChannel.WHATSAPP);
  });

  it("runs the same query the controller ran: latest by timestamp, channel only", async () => {
    await getGuestChannel("g1", "h1");
    expect(findFirst).toHaveBeenCalledWith({
      where:   { guestId: "g1", hotelId: "h1" },
      orderBy: { timestamp: "desc" },
      select:  { channel: true },
    });
  });
});
