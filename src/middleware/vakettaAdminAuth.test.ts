/**
 * vakettaAdminAuth rejects non-superadmin callers. A hotel-staff JWT (no
 * type: "vaketta_admin") must NOT be able to reach superadmin-only routes such
 * as PATCH /admin/hotels/:hotelId/max-stay → 401.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

// Stable secret for both signing test tokens and verifying inside the middleware.
beforeAll(() => { process.env.JWT_SECRET = "test-secret-vaketta"; });

// Block-list check must not gate the test — pretend nothing is blocked.
vi.mock("../utils/tokenBlocklist", () => ({ isTokenBlocked: vi.fn(async () => false) }));

import { vakettaAdminAuth } from "./vakettaAdminAuth";
import { signToken } from "../utils/jwt";
import { signVakettaToken } from "../utils/vakettaJwt";

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json   = vi.fn((b: any) => { res.body = b; return res; });
  return res;
}

describe("vakettaAdminAuth", () => {
  it("rejects a hotel-staff token with 401 (cannot reach /admin routes)", async () => {
    const hotelToken = signToken({ id: "u1", role: "ADMIN", hotelId: "h1" });
    const req: any = { cookies: {}, headers: { authorization: `Bearer ${hotelToken}` } };
    const res = mockRes();
    const next = vi.fn();

    await vakettaAdminAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects when no token is present", async () => {
    const req: any = { cookies: {}, headers: {} };
    const res = mockRes();
    const next = vi.fn();

    await vakettaAdminAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("accepts a genuine vaketta_admin token", async () => {
    const adminToken = signVakettaToken({ id: "a1", email: "admin@vaketta.com", name: "Admin" });
    const req: any = { cookies: {}, headers: { authorization: `Bearer ${adminToken}` } };
    const res = mockRes();
    const next = vi.fn();

    await vakettaAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect((req as any).vakettaAdmin?.id).toBe("a1");
  });
});
