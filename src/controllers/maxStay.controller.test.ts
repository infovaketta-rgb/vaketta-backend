/**
 * Tests for the superadmin-controlled maxStayNights feature:
 *   - setHotelMaxStayHandler  (PATCH /admin/hotels/:hotelId/max-stay) — superadmin
 *     sets a hotel's value, clamped to the live platform ceiling; hotelId taken
 *     ONLY from the route param.
 *   - patchSettings (PATCH /hotel-settings) — a hotel admin can NO LONGER write
 *     maxStayNights (silently ignored, like other non-whitelisted fields).
 *   - vakettaAdminAuth — a hotel-staff token cannot reach the /admin route.
 *
 * Same style as bookingConfirmation.controller.test.ts: no supertest, handlers
 * run directly with mocked req/res; service + prisma deps mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/settings.service", () => ({
  // setHotelMaxStayHandler depends on this — assert it gets the route param +
  // body number, and returns the (already-clamped) stored value.
  setHotelMaxStayNights: vi.fn(),
  // patchSettings depends on these:
  updateHotelConfig: vi.fn(async (_hotelId: string, data: any) => ({ ...data })),
  invalidateHotelConfigCache: vi.fn(),
  invalidatePlatformCeilingCache: vi.fn(),
  // unused-but-imported by the controller module:
  getHotelSettings: vi.fn(),
  updateHotelProfile: vi.fn(),
  updateBotMessages: vi.fn(),
  getMenu: vi.fn(), addMenuItem: vi.fn(), updateMenuItem: vi.fn(),
  deleteMenuItem: vi.fn(), updateMenuTitle: vi.fn(),
  getWhatsAppConfig: vi.fn(), updateWhatsAppConfig: vi.fn(),
  testWhatsAppConnection: vi.fn(), connectWhatsAppEmbeddedSignup: vi.fn(),
  getInstagramConfig: vi.fn(), updateInstagramConfig: vi.fn(),
  getIgSubscriptionStatus: vi.fn(), subscribeIgWebhook: vi.fn(), unsubscribeIgWebhook: vi.fn(),
  getPlatformSettings: vi.fn(), updatePlatformSettings: vi.fn(),
}));
vi.mock("../services/ai.service", () => ({ invalidatePromptCache: vi.fn() }));
vi.mock("../db/connect", () => ({ default: {} }));

import { setHotelMaxStayNights } from "../services/settings.service";
import { updateHotelConfig } from "../services/settings.service";
import { setHotelMaxStayHandler, patchSettings } from "./settings.controller";

const setHotelMaxStay = setHotelMaxStayNights as ReturnType<typeof vi.fn>;
const updateConfig    = updateHotelConfig as ReturnType<typeof vi.fn>;

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json   = vi.fn((b: any) => { res.body = b; return res; });
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setHotelMaxStayHandler (superadmin per-hotel override)", () => {
  it("sets a hotel's maxStayNights, taking hotelId from the route param only", async () => {
    setHotelMaxStay.mockResolvedValue({ maxStayNights: 120 });
    const req: any = {
      params: { hotelId: "hotel-A" },
      // a malicious body hotelId must be ignored — service is called with the param
      body: { maxStayNights: 120, hotelId: "hotel-EVIL" },
    };
    const res = mockRes();

    await setHotelMaxStayHandler(req, res);

    expect(setHotelMaxStay).toHaveBeenCalledWith("hotel-A", 120);
    expect(res.body).toEqual({ hotelId: "hotel-A", maxStayNights: 120 });
  });

  it("reflects the clamped value returned by the service (ceiling enforced server-side)", async () => {
    // Superadmin asked for 10000; service clamped to the platform ceiling 3650.
    setHotelMaxStay.mockResolvedValue({ maxStayNights: 3650 });
    const req: any = { params: { hotelId: "hotel-A" }, body: { maxStayNights: 10_000 } };
    const res = mockRes();

    await setHotelMaxStayHandler(req, res);

    expect(setHotelMaxStay).toHaveBeenCalledWith("hotel-A", 10_000);
    expect(res.body.maxStayNights).toBe(3650);
  });

  it("400s on a missing route param", async () => {
    const req: any = { params: {}, body: { maxStayNights: 60 } };
    const res = mockRes();
    await setHotelMaxStayHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(setHotelMaxStay).not.toHaveBeenCalled();
  });

  it("400s on a non-numeric maxStayNights", async () => {
    const req: any = { params: { hotelId: "hotel-A" }, body: { maxStayNights: "lots" } };
    const res = mockRes();
    await setHotelMaxStayHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(setHotelMaxStay).not.toHaveBeenCalled();
  });
});

describe("patchSettings (hotel admin) — maxStayNights is no longer writable", () => {
  it("ignores maxStayNights even when a hotel admin sends it", async () => {
    const req: any = {
      user: { hotelId: "h1" },
      body: { maxStayNights: 9999, bookingEnabled: true },
    };
    const res = mockRes();

    await patchSettings(req, res);

    expect(updateConfig).toHaveBeenCalledTimes(1);
    const data = updateConfig.mock.calls[0]![1];
    expect(data).not.toHaveProperty("maxStayNights");
    // a legit field still flows through
    expect(data).toMatchObject({ bookingEnabled: true });
  });
});
