/**
 * Tests for planCarousel.ts. The pure buildPlanDetailText cases need no DB/API;
 * the trySendPlanCarousel cases mock prisma + the WhatsApp senders + emit so we
 * can assert ordering (text BEFORE carousel) and the non-fatal text failure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/connect", () => ({
  default: {
    hotel:     { findUnique: vi.fn() },
    guest:     { findUnique: vi.fn() },
    roomPhoto: { findMany:   vi.fn() },
    message:   { create:     vi.fn() },
  },
}));
vi.mock("../../services/whatsapp.send.service", () => ({
  sendCarouselMessage: vi.fn(),
  sendTextMessage:     vi.fn(),
}));
vi.mock("../../utils/encryption.utils", () => ({ decryptWhatsAppToken: vi.fn(() => "tok") }));
vi.mock("../../realtime/emit", () => ({ emitToHotel: vi.fn() }));

import prisma from "../../db/connect";
import { sendCarouselMessage, sendTextMessage } from "../../services/whatsapp.send.service";
import { buildPlanDetailText, trySendPlanCarousel } from "./planCarousel";
import type { AllocationPlan, AllocationRoom } from "./advancedRoomAllocation";

// ── Builders ──────────────────────────────────────────────────────────────────
function pr(over: Partial<AllocationRoom> = {}): AllocationRoom {
  return {
    roomTypeId: "rt_a", roomTypeName: "Deluxe",
    adults: 2, children: 0, extraBed: false,
    basePrice: 5000, extraAdultCost: 0, extraBedCost: 0, childAgeLimit: null,
    pricePerNight: 5000, nights: 2, totalPrice: 10000,
    ...over,
  };
}
function pl(over: Partial<AllocationPlan> = {}): AllocationPlan {
  const rooms = over.rooms ?? [pr({})];
  return {
    label: "Most Comfortable", planTag: "comfort", rooms,
    totalPrice: rooms.reduce((s, r) => s + r.totalPrice, 0),
    nights: rooms[0]?.nights ?? 2,
    roomCount: rooms.length,
    extraBedCount: rooms.filter((r) => r.extraBed).length,
    primaryRoomTypeId: rooms[0]?.roomTypeId ?? "rt_a",
    ...over,
  };
}

describe("plan detail text", () => {
  // ── buildPlanDetailText ──────────────────────────────────────────────────────
  // 1. Two plans, no extra beds.
  it("Case PD1: two plans show totals, types, counts, per-night price, 'no extra beds'", () => {
    const plans = [
      pl({ label: "Most Comfortable", rooms: [pr({ adults: 2 }), pr({ adults: 2 })] }),       // total 20000
      pl({ label: "Fewer Rooms", rooms: [pr({ adults: 3, pricePerNight: 6000, totalPrice: 12000 })] }),
    ];
    const text = buildPlanDetailText(plans);
    expect(text).toContain("₹20,000");
    expect(text).toContain("₹12,000");
    expect(text).toContain("Deluxe");
    expect(text).toContain("2 adults");
    expect(text).toContain("₹5,000");        // per-night price
    expect(text).toContain("no extra beds");
  });

  // 2. Plan with extra-bed rooms.
  it("Case PD2: extra-bed rooms show '+ bed' and 'extra beds included'", () => {
    const text = buildPlanDetailText([pl({ rooms: [pr({ adults: 3, extraBed: true })] })]);
    expect(text).toContain("+ bed");
    expect(text).toContain("extra beds included");
  });

  // 3. Singular / plural.
  it("Case PD3: '1 adult' and '1 child' (not pluralised)", () => {
    const text = buildPlanDetailText([pl({ rooms: [pr({ adults: 1, children: 1 })] })]);
    expect(text).toContain("1 adult");
    expect(text).not.toContain("1 adults");
    expect(text).toContain("1 child");
    expect(text).not.toContain("1 children");
    expect(text).not.toContain("1 childs");
  });

  // 4. Rupee formatting (Indian locale).
  it("Case PD4: amounts use Indian locale grouping", () => {
    const text = buildPlanDetailText([pl({ totalPrice: 60000, rooms: [pr({ pricePerNight: 1500, totalPrice: 3000 })] })]);
    expect(text).toContain("₹1,500");
    expect(text).not.toContain("₹1500");
    expect(text).toContain("₹60,000");
    expect(text).not.toContain("₹60000");
  });

  // 5. Trailing swipe line.
  it("Case PD5: ends with the swipe CTA", () => {
    const text = buildPlanDetailText([pl({}), pl({})]);
    expect(text).toContain("Swipe the cards below to choose");
    expect(text.trimEnd().endsWith("👇")).toBe(true);
  });

  // 6. Pure / deterministic.
  it("Case PD6: same input → identical output", () => {
    const plans = [pl({ rooms: [pr({ adults: 3, extraBed: true }), pr({ adults: 2 })] }), pl({})];
    expect(buildPlanDetailText(plans)).toBe(buildPlanDetailText(plans));
  });

  // ── trySendPlanCarousel ──────────────────────────────────────────────────────
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["MOCK_WHATSAPP_SEND"] = "";
    vi.mocked(prisma.hotel.findUnique).mockResolvedValue({
      id: "h1", phone: "H", config: { metaPhoneNumberId: "PN", metaAccessTokenEncrypted: "enc" },
    } as never);
    vi.mocked(prisma.guest.findUnique).mockResolvedValue({ phone: "G" } as never);
    vi.mocked(prisma.roomPhoto.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.message.create).mockImplementation((async (arg: { data: unknown }) => ({ id: "m", ...(arg.data as object) })) as never);
    vi.mocked(sendTextMessage).mockResolvedValue({ messages: [{ id: "txt-wamid" }] } as never);
    vi.mocked(sendCarouselMessage).mockResolvedValue("car-wamid");
  });

  const twoPlans = (): AllocationPlan[] => [pl({ label: "A" }), pl({ label: "B", rooms: [pr({ adults: 3 }), pr({ adults: 2 })] })];

  // 7. Text persisted BEFORE the carousel.
  it("Case PD7: detail text is sent + persisted before the carousel", async () => {
    const ok = await trySendPlanCarousel({ hotelId: "h1", guestId: "g1", plans: twoPlans(), bodyText: "ignored" });
    expect(ok).toBe(true);

    const types = vi.mocked(prisma.message.create).mock.calls.map((c) => (c[0] as { data: { messageType: string } }).data.messageType);
    expect(types[0]).toBe("text");      // text persisted first
    expect(types[1]).toBe("carousel");  // carousel second

    // And the text was actually SENT before the carousel.
    expect(vi.mocked(sendTextMessage).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(sendCarouselMessage).mock.invocationCallOrder[0]!);
  });

  // 8. Text send failure is non-fatal → carousel still sent, returns true.
  it("Case PD8: text-send failure still sends the carousel and returns true", async () => {
    vi.mocked(sendTextMessage).mockRejectedValue(new Error("text boom"));
    const ok = await trySendPlanCarousel({ hotelId: "h1", guestId: "g1", plans: twoPlans(), bodyText: "ignored" });
    expect(ok).toBe(true);
    expect(sendCarouselMessage).toHaveBeenCalledTimes(1);

    const types = vi.mocked(prisma.message.create).mock.calls.map((c) => (c[0] as { data: { messageType: string } }).data.messageType);
    expect(types).toContain("carousel");
    expect(types).not.toContain("text"); // text persist skipped (send threw first)
  });
});
