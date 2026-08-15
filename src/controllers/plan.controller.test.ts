/**
 * Plan/subscription admin endpoints.
 *
 * Locks in the input handling that used to be absent:
 *  - `"abc"` / negative / fractional money is a 400, not a NaN that reaches
 *    Prisma and surfaces as a 500 with the raw Prisma message;
 *  - a negative `conversationLimit` is rejected — it used to be storable, and
 *    `usage >= -5` is always true, which silenced the hotel's bot permanently;
 *  - `country` is persisted (the admin UI has always sent it; the controller
 *    dropped it and the column did not exist, so every plan was silently global);
 *  - `isActive: "false"` doesn't enable a plan (`Boolean("false") === true`);
 *  - an inactive plan cannot be assigned;
 *  - and the SUPPORT role cannot touch prices.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VakettaAdminRole } from "@prisma/client";

const createPlan = vi.fn(async (data: any) => ({ id: "plan_new", isActive: true, ...data }));
const updatePlan = vi.fn(async (id: string, data: any) => ({ id, ...data }));
const getPlanById = vi.fn();
const assignPlanToHotel = vi.fn(async (_hotelId: string, _planId: string, _opts?: any) => ({ id: "sub_1" }));
const startTrial = vi.fn(async (_hotelId: string, _overrides?: any) => ({ subscriptionStatus: "TRIALING" }));

vi.mock("../services/plan.service", () => ({
  createPlan: (...a: any[]) => createPlan(a[0]),
  updatePlan: (...a: any[]) => updatePlan(a[0], a[1]),
  getPlanById: (...a: any[]) => getPlanById(a[0]),
  getPlans: vi.fn(async () => []),
}));

vi.mock("../services/billing.service", () => ({
  assignPlanToHotel: (...a: any[]) => assignPlanToHotel(a[0], a[1], a[2]),
  startTrial: (...a: any[]) => startTrial(a[0], a[1]),
  cancelSubscription: vi.fn(),
  extendSubscription: vi.fn(),
}));

vi.mock("../services/audit.service", () => ({ recordBillingEvent: vi.fn() }));

import {
  createPlanHandler,
  updatePlanHandler,
  assignPlanHandler,
  startTrialHandler,
} from "./plan.controller";
import { requireVakettaRole } from "../middleware/requireVakettaRole";

const adminFindUnique = vi.fn();
vi.mock("../db/connect", () => ({
  default: { vakettaAdmin: { findUnique: (...a: any[]) => adminFindUnique(a[0]) } },
}));
vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

function mockRes() {
  const json = vi.fn();
  const res: any = { json, status: vi.fn(() => ({ json })) };
  res.__json = json;
  return res;
}

const VALID_PLAN = {
  name: "Starter",
  currency: "INR",
  country: "IN",
  priceMonthly: 249900,
  conversationLimit: 2000,
  aiReplyLimit: 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  getPlanById.mockResolvedValue({ id: "plan_1", isActive: true, name: "Starter", priceMonthly: 249900 });
});

describe("createPlanHandler validation", () => {
  it("rejects a non-numeric price with 400 instead of a 500 from Prisma", async () => {
    const res = mockRes();
    await createPlanHandler({ body: { ...VALID_PLAN, priceMonthly: "abc" } } as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.__json.mock.calls[0]?.[0]?.error).toContain("priceMonthly");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it.each([
    ["negative price", { priceMonthly: -100 }],
    ["fractional price", { priceMonthly: 49.5 }],
    ["negative conversation limit", { conversationLimit: -5 }],
    ["negative AI limit", { aiReplyLimit: -1 }],
    ["bad currency", { currency: "RUPEES" }],
    ["bad country", { country: "INDIA" }],
    ["empty name", { name: "  " }],
  ])("rejects %s", async (_label, override) => {
    const res = mockRes();
    await createPlanHandler({ body: { ...VALID_PLAN, ...override } } as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("persists country — the field the controller used to drop entirely", async () => {
    const res = mockRes();
    await createPlanHandler({ body: VALID_PLAN } as any, res);

    expect(createPlan).toHaveBeenCalledWith(expect.objectContaining({ country: "IN" }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("normalises currency and country casing", async () => {
    const res = mockRes();
    await createPlanHandler({ body: { ...VALID_PLAN, currency: "inr", country: "in" } } as any, res);
    expect(createPlan).toHaveBeenCalledWith(expect.objectContaining({ currency: "INR", country: "IN" }));
  });

  it("defaults country to ALL when omitted", async () => {
    const res = mockRes();
    const { country, ...noCountry } = VALID_PLAN;
    await createPlanHandler({ body: noCountry } as any, res);
    expect(createPlan).toHaveBeenCalledWith(expect.objectContaining({ country: "ALL" }));
  });

  it("accepts 0 for price (free) and 0 for limits (unlimited)", async () => {
    const res = mockRes();
    await createPlanHandler(
      { body: { ...VALID_PLAN, priceMonthly: 0, conversationLimit: 0, aiReplyLimit: 0 } } as any,
      res,
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe("updatePlanHandler validation", () => {
  it("validates partial updates — it previously validated nothing", async () => {
    const res = mockRes();
    await updatePlanHandler({ params: { id: "plan_1" }, body: { priceMonthly: -1 } } as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(updatePlan).not.toHaveBeenCalled();
  });

  it('does not enable a plan when isActive is the string "false"', async () => {
    const res = mockRes();
    await updatePlanHandler({ params: { id: "plan_1" }, body: { isActive: "false" } } as any, res);

    // Boolean("false") is true — the old code would have set isActive: true.
    expect(updatePlan).toHaveBeenCalledWith("plan_1", { isActive: false });
  });

  it("only writes the fields that were supplied", async () => {
    const res = mockRes();
    await updatePlanHandler({ params: { id: "plan_1" }, body: { name: "Renamed" } } as any, res);
    expect(updatePlan).toHaveBeenCalledWith("plan_1", { name: "Renamed" });
  });

  it("400s an empty update rather than issuing a no-op write", async () => {
    const res = mockRes();
    await updatePlanHandler({ params: { id: "plan_1" }, body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("404s an unknown plan", async () => {
    getPlanById.mockResolvedValue(null);
    const res = mockRes();
    await updatePlanHandler({ params: { id: "nope" }, body: { name: "X" } } as any, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("assignPlanHandler", () => {
  it("refuses to assign an inactive plan — never previously checked", async () => {
    getPlanById.mockResolvedValue({ id: "plan_1", isActive: false });
    const res = mockRes();
    await assignPlanHandler({ params: { id: "h1" }, body: { planId: "plan_1" } } as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(assignPlanToHotel).not.toHaveBeenCalled();
  });

  it("404s an unknown plan", async () => {
    getPlanById.mockResolvedValue(null);
    const res = mockRes();
    await assignPlanHandler({ params: { id: "h1" }, body: { planId: "nope" } } as any, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("404s an unknown hotel rather than 500ing on a raw Prisma error", async () => {
    assignPlanToHotel.mockRejectedValueOnce(new Error("Hotel not found"));
    const res = mockRes();
    await assignPlanHandler({ params: { id: "nope" }, body: { planId: "plan_1" } } as any, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("400s a missing planId", async () => {
    const res = mockRes();
    await assignPlanHandler({ params: { id: "h1" }, body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("startTrialHandler", () => {
  it("rejects a negative conversationLimit — it used to silence the bot forever", async () => {
    const res = mockRes();
    await startTrialHandler({ params: { id: "h1" }, body: { conversationLimit: -5 } } as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(startTrial).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range duration instead of silently clamping it", async () => {
    const res = mockRes();
    await startTrialHandler({ params: { id: "h1" }, body: { days: 9999 } } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("passes valid overrides through", async () => {
    const res = mockRes();
    await startTrialHandler(
      { params: { id: "h1" }, body: { days: 30, conversationLimit: 100, aiReplyLimit: 0 } } as any,
      res,
    );
    expect(startTrial).toHaveBeenCalledWith("h1", {
      durationDays: 30,
      conversationLimit: 100,
      aiReplyLimit: 0,
    });
  });

  it("uses the global defaults when no overrides are given", async () => {
    const res = mockRes();
    await startTrialHandler({ params: { id: "h1" }, body: {} } as any, res);
    expect(startTrial).toHaveBeenCalledWith("h1", {});
  });
});

describe("requireVakettaRole — money-touching routes were open to every admin", () => {
  function run(role: VakettaAdminRole | null, allowed: VakettaAdminRole[]) {
    adminFindUnique.mockResolvedValue(role ? { role } : null);
    const req: any = { vakettaAdmin: { id: "admin_1" } };
    const res = mockRes();
    const next = vi.fn();
    return { promise: requireVakettaRole(...allowed)(req, res, next), res, next, req };
  }

  it("blocks SUPPORT from billing writes", async () => {
    const { promise, res, next } = run(VakettaAdminRole.SUPPORT, [
      VakettaAdminRole.SUPER_ADMIN,
      VakettaAdminRole.ADMIN,
    ]);
    await promise;

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([VakettaAdminRole.ADMIN, VakettaAdminRole.SUPER_ADMIN])("allows %s", async (role) => {
    const { promise, next, res } = run(role, [VakettaAdminRole.SUPER_ADMIN, VakettaAdminRole.ADMIN]);
    await promise;

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks ADMIN from SUPER_ADMIN-only platform settings", async () => {
    const { promise, res } = run(VakettaAdminRole.ADMIN, [VakettaAdminRole.SUPER_ADMIN]);
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("401s when the token outlived the admin account", async () => {
    const { promise, res } = run(null, [VakettaAdminRole.ADMIN]);
    await promise;
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("401s when auth middleware did not run", async () => {
    const req: any = {};
    const res = mockRes();
    const next = vi.fn();
    await requireVakettaRole(VakettaAdminRole.ADMIN)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the role cannot be verified", async () => {
    adminFindUnique.mockRejectedValue(new Error("db down"));
    const req: any = { vakettaAdmin: { id: "admin_1" } };
    const res = mockRes();
    const next = vi.fn();
    await requireVakettaRole(VakettaAdminRole.ADMIN)(req, res, next);

    // An unverifiable role must never authorise a price change.
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});
