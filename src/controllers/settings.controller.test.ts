/**
 * patchSettings (PATCH /hotel-settings) — HotelConfig.childAgeLimit.
 *
 * Validated by the pure parseChildAgeLimit (integer 0–17, never clamped). An
 * invalid value rejects the WHOLE request: nothing is written and no cache is
 * invalidated. Same style as maxStay.controller.test.ts: the handler runs
 * directly with mocked req/res; service + prisma deps mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/settings.service", () => ({
  updateHotelConfig: vi.fn(async (_hotelId: string, data: any) => ({ hotelId: _hotelId, ...data })),
  invalidateHotelConfigCache: vi.fn(),
  invalidatePlatformCeilingCache: vi.fn(),
  // imported by the controller module, unused here:
  getHotelSettings: vi.fn(), updateHotelProfile: vi.fn(), updateBotMessages: vi.fn(),
  getMenu: vi.fn(), addMenuItem: vi.fn(), updateMenuItem: vi.fn(),
  deleteMenuItem: vi.fn(), updateMenuTitle: vi.fn(),
  getWhatsAppConfig: vi.fn(), updateWhatsAppConfig: vi.fn(),
  testWhatsAppConnection: vi.fn(), connectWhatsAppEmbeddedSignup: vi.fn(),
  triggerWhatsAppHistoryResync: vi.fn(),
  getInstagramConfig: vi.fn(), updateInstagramConfig: vi.fn(),
  getPlatformSettings: vi.fn(), updatePlatformSettings: vi.fn(),
  setHotelMaxStayNights: vi.fn(),
}));
vi.mock("../services/ai.service", () => ({ invalidatePromptCache: vi.fn() }));
vi.mock("../db/connect", () => ({ default: {} }));

import { updateHotelConfig, invalidateHotelConfigCache } from "../services/settings.service";
import { invalidatePromptCache } from "../services/ai.service";
import { patchSettings } from "./settings.controller";

const updateConfig      = updateHotelConfig as ReturnType<typeof vi.fn>;
const invalidateConfig  = invalidateHotelConfigCache as ReturnType<typeof vi.fn>;
const invalidatePrompt  = invalidatePromptCache as ReturnType<typeof vi.fn>;

const ERROR = "Child age limit must be a whole number from 0 to 17.";

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json   = vi.fn((b: any) => { res.body = b; return res; });
  return res;
}

async function patch(body: Record<string, unknown>) {
  const req: any = { user: { hotelId: "hotel_1" }, body };
  const res = mockRes();
  await patchSettings(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("patchSettings — childAgeLimit", () => {
  it.each([0, 12, 17])("CA1: a valid value (%j) is saved and both caches are invalidated", async (v) => {
    const res = await patch({ childAgeLimit: v });

    expect(res.statusCode).toBe(200);
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith("hotel_1", { childAgeLimit: v });
    expect(invalidateConfig).toHaveBeenCalledWith("hotel_1");
    expect(invalidatePrompt).toHaveBeenCalledWith("hotel_1");
    expect(res.body).toEqual({ hotelId: "hotel_1", childAgeLimit: v });
  });

  it.each([
    ["-1", -1], ["18", 18], ["12.5", 12.5], ['"12"', "12"],
    ["null", null], ["NaN", NaN], ["Infinity", Infinity], ["true", true],
  ])("CA2: an invalid value (%s) gives 400, writes nothing, invalidates nothing", async (_label, v) => {
    const res = await patch({ childAgeLimit: v });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: ERROR });
    expect(updateConfig).not.toHaveBeenCalled();
    expect(invalidateConfig).not.toHaveBeenCalled();
    expect(invalidatePrompt).not.toHaveBeenCalled();
  });

  it("CA3: an invalid childAgeLimit alongside valid fields saves NO field", async () => {
    const res = await patch({ childAgeLimit: 18, bookingEnabled: false, welcomeMessage: "Hello!" });

    expect(res.statusCode).toBe(400);
    expect(updateConfig).not.toHaveBeenCalled();
    expect(invalidateConfig).not.toHaveBeenCalled();
    expect(invalidatePrompt).not.toHaveBeenCalled();
  });

  it("CA4: a valid childAgeLimit is saved together with the other fields in one write", async () => {
    await patch({ childAgeLimit: 10, bookingEnabled: false });

    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith("hotel_1", { bookingEnabled: false, childAgeLimit: 10 });
  });

  it("CA5: omitted childAgeLimit — other fields behave exactly as before and the key is not written", async () => {
    const res = await patch({
      bookingEnabled: true,
      businessStartHour: "9",
      bookingFlowId: "",
      aiInstructions: "",
    });

    expect(res.statusCode).toBe(200);
    const data = updateConfig.mock.calls[0]![1];
    expect(data).toEqual({
      bookingEnabled: true,
      businessStartHour: 9,     // Number() coercion unchanged
      bookingFlowId: null,      // "" → null unchanged
      aiInstructions: null,     // "" → null unchanged
    });
    expect(data).not.toHaveProperty("childAgeLimit");
    expect(invalidateConfig).toHaveBeenCalledWith("hotel_1");
    expect(invalidatePrompt).toHaveBeenCalledWith("hotel_1");
  });
});
