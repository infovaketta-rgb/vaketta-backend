/**
 * Tests for planList.ts. The pure buildPlanDetailText cases need no DB/API; the
 * trySendPlanList cases mock prisma + sendListMessage + emit so we can assert the
 * single interactive-list send (plan_N rows, messageType "list") and the body
 * truncation edge case.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/connect", () => ({
  default: {
    hotel:   { findUnique: vi.fn() },
    guest:   { findUnique: vi.fn() },
    message: { create:     vi.fn() },
  },
}));
vi.mock("../../services/whatsapp.send.service", () => ({ sendListMessage: vi.fn() }));
vi.mock("../../utils/encryption.utils", () => ({ decryptWhatsAppToken: vi.fn(() => "tok") }));
vi.mock("../../realtime/emit", () => ({ emitToHotel: vi.fn() }));

import prisma from "../../db/connect";
import { sendListMessage } from "../../services/whatsapp.send.service";
import { buildPlanDetailText, buildPlanDescription, trySendPlanList } from "./planList";
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

type ListOpts = { bodyText: string; buttonLabel: string; sections: { title: string; rows: { id: string; title: string; description: string }[] }[] };
const lastListOpts = (): ListOpts => vi.mocked(sendListMessage).mock.calls[0]![3] as ListOpts;

describe("plan detail text", () => {
  // ── buildPlanDetailText (unchanged) ──────────────────────────────────────────
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

  // 5. Trailing CTA line.
  it("Case PD5: ends with the tap CTA", () => {
    const text = buildPlanDetailText([pl({}), pl({})]);
    expect(text).toContain("Tap *View Plans* to choose");
    expect(text.trimEnd().endsWith("👇")).toBe(true);
  });

  // 6. Pure / deterministic.
  it("Case PD6: same input → identical output", () => {
    const plans = [pl({ rooms: [pr({ adults: 3, extraBed: true }), pr({ adults: 2 })] }), pl({})];
    expect(buildPlanDetailText(plans)).toBe(buildPlanDetailText(plans));
  });

  // ── trySendPlanList ──────────────────────────────────────────────────────────
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["MOCK_WHATSAPP_SEND"] = "";
    vi.mocked(prisma.hotel.findUnique).mockResolvedValue({
      id: "h1", phone: "H", config: { metaPhoneNumberId: "PN", metaAccessTokenEncrypted: "enc" },
    } as never);
    vi.mocked(prisma.guest.findUnique).mockResolvedValue({ phone: "G" } as never);
    vi.mocked(prisma.message.create).mockImplementation((async (arg: { data: unknown }) => ({ id: "m", ...(arg.data as object) })) as never);
    vi.mocked(sendListMessage).mockResolvedValue("list-wamid");
  });

  const twoPlans = (): AllocationPlan[] => [pl({ label: "A" }), pl({ label: "B", rooms: [pr({ adults: 3 }), pr({ adults: 2 })] })];

  // 7. One interactive list, plan_N rows, persisted as messageType "list".
  it("Case PD7: sends one list with plan_N rows and persists a single 'list' message", async () => {
    const plans = twoPlans();
    const ok = await trySendPlanList({ hotelId: "h1", guestId: "g1", plans });
    expect(ok).toBe(true);
    expect(sendListMessage).toHaveBeenCalledTimes(1);

    const opts = lastListOpts();
    expect(opts.buttonLabel).toBe("View Plans");
    expect(opts.sections[0]!.title).toBe("Choose a Plan");
    const rows = opts.sections[0]!.rows;
    expect(rows.map((r) => r.id)).toEqual(["plan_0", "plan_1"]);
    expect(rows[0]!.title.startsWith("Plan 1")).toBe(true);
    expect(rows[0]!.title.length).toBeLessThanOrEqual(24);
    expect(rows[1]!.description).toBe(buildPlanDescription(plans[1]!));
    expect(opts.bodyText).toContain("Your Room Options"); // full breakdown is the body

    const calls = vi.mocked(prisma.message.create).mock.calls;
    expect(calls).toHaveLength(1); // single message, no pre-text
    expect((calls[0]![0] as { data: { messageType: string } }).data.messageType).toBe("list");
  });

  // 8. Body is truncated to ≤1024 chars for very large plans.
  it("Case PD8: list body truncated to ≤1024 chars", async () => {
    const manyRooms = Array.from({ length: 40 }, (_, k) => pr({ roomTypeName: `Room Type ${k}`, adults: 3, extraBed: true }));
    await trySendPlanList({ hotelId: "h1", guestId: "g1", plans: [pl({ label: "Big", rooms: manyRooms }), pl({ label: "B" })] });
    const { bodyText } = lastListOpts();
    expect(bodyText.length).toBeLessThanOrEqual(1024);
    expect(bodyText.endsWith("…")).toBe(true);
  });

  // 9. Missing credentials → returns false (no send).
  it("Case PD9: returns false when the hotel has no Meta credentials", async () => {
    vi.mocked(prisma.hotel.findUnique).mockResolvedValue({ id: "h1", phone: "H", config: {} } as never);
    const ok = await trySendPlanList({ hotelId: "h1", guestId: "g1", plans: twoPlans() });
    expect(ok).toBe(false);
    expect(sendListMessage).not.toHaveBeenCalled();
  });
});
