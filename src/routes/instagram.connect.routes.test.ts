/**
 * Tests for the Business Login for Instagram connect route:
 *   POST /api/instagram/exchange-code
 *
 * No Facebook Page lookup — the code flow grants direct Instagram account access.
 * No-supertest style: the router is driven directly with mocked req/res.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/instagram.auth.service", () => ({
  connectInstagram: vi.fn(),
}));

import router from "./instagram.connect.routes";
import { connectInstagram } from "../services/instagram.auth.service";

const connect = connectInstagram as ReturnType<typeof vi.fn>;

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json   = vi.fn((b: any)    => { res.body = b;       return res; });
  return res;
}

function call(body: any, hotelId = "hotel-1") {
  return new Promise<any>((resolve, reject) => {
    const res = mockRes();
    const origJson = res.json;
    res.json = vi.fn((b: any) => { origJson(b); resolve(res); return res; });
    const req: any = { method: "POST", url: "/exchange-code", body, user: { hotelId } };
    (router as any)(req, res, (err: any) => (err ? reject(err) : resolve(res)));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/instagram/exchange-code", () => {
  it("400s when code is missing", async () => {
    const res = await call({ redirectUri: "https://vaketta.com/dashboard/configuration" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/code is required/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it("400s when redirectUri is missing", async () => {
    const res = await call({ code: "abc123" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/redirectUri is required/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects successfully and returns instagramBusinessAccountId + username", async () => {
    connect.mockResolvedValue({
      instagramBusinessAccountId: "17841400123456789",
      username: "maadathilresort",
    });

    const res = await call({
      code:        "AQBx_test_code",
      redirectUri: "https://vaketta.com/dashboard/configuration",
    });

    expect(connect).toHaveBeenCalledWith(
      "hotel-1",
      "AQBx_test_code",
      "https://vaketta.com/dashboard/configuration",
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success:                    true,
      instagramBusinessAccountId: "17841400123456789",
      username:                   "maadathilresort",
    });
  });

  it("502s when connectInstagram throws (e.g. invalid code)", async () => {
    connect.mockRejectedValue(new Error("Failed to exchange Instagram code for token"));

    const res = await call({
      code:        "expired-code",
      redirectUri: "https://vaketta.com/dashboard/configuration",
    });

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/exchange Instagram code/i);
  });

  it("hotelId is taken from JWT (req.user), never from body", async () => {
    connect.mockResolvedValue({
      instagramBusinessAccountId: "ig-123",
      username: "test",
    });

    await call(
      { code: "x", redirectUri: "https://vaketta.com/dashboard/configuration", hotelId: "attacker" },
      "hotel-from-jwt",
    );

    expect(connect).toHaveBeenCalledWith("hotel-from-jwt", "x", expect.any(String));
  });
});
