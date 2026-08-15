/**
 * The soft paywall.
 *
 * The behaviour under test is the fix for a hard dead-end: `auth` used to return
 * 402 for EVERY authenticated route when a subscription lapsed, including
 * `/hotel-settings/billing/*` — so the redirect target of the 402 was itself
 * 402'd, and an expired customer could not see their plan, their usage, or the
 * plans available to upgrade to. It also cut staff off from guest conversations,
 * contradicting the product's own Help copy.
 */
import { describe, it, expect, vi } from "vitest";
import { requireActiveSubscription } from "./requireActiveSubscription";
import { SubscriptionStatus } from "@prisma/client";

function run(opts: {
  method?: string;
  path?: string;
  originalUrl?: string;
  status?: SubscriptionStatus | null;
}) {
  const { method = "GET", path = "/", status = SubscriptionStatus.ACTIVE } = opts;

  const req: any = {
    method,
    path,
    originalUrl: opts.originalUrl ?? path,
    subscription:
      status === null
        ? undefined
        : {
            status,
            suspended: status === SubscriptionStatus.EXPIRED || status === SubscriptionStatus.CANCELED,
            pastDue: status === SubscriptionStatus.PAST_DUE,
          },
  };

  const json = vi.fn();
  const res: any = { status: vi.fn(() => ({ json })), json };
  const next = vi.fn();

  requireActiveSubscription(req, res, next);
  return { next, res, json };
}

describe("an ACTIVE hotel is never gated", () => {
  it.each(["GET", "POST", "PATCH", "DELETE"])("%s passes through", (method) => {
    const { next, res } = run({ method, path: "/messages" });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("an EXPIRED hotel keeps read access", () => {
  it.each([
    ["/conversations", "GET"],
    ["/bookings", "GET"],
    ["/guests", "HEAD"],
    ["/dashboard", "OPTIONS"],
  ])("can still read %s (%s)", (path, method) => {
    const { next, res } = run({ method, path, status: SubscriptionStatus.EXPIRED });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("an EXPIRED hotel cannot write", () => {
  it.each([
    ["/messages", "POST"],
    ["/bookings", "POST"],
    ["/room-types", "PATCH"],
    ["/guests", "DELETE"],
  ])("%s %s is 402", (path, method) => {
    const { next, res, json } = run({ method, path, status: SubscriptionStatus.EXPIRED });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "SUBSCRIPTION_EXPIRED" }));
  });

  it("explains that data is still readable rather than just saying 'expired'", () => {
    const { json } = run({ method: "POST", path: "/messages", status: SubscriptionStatus.EXPIRED });
    expect(json.mock.calls[0]?.[0]?.error).toMatch(/still view/i);
  });
});

describe("the billing routes are never gated — this is how a customer pays us", () => {
  it.each(["GET", "POST", "PATCH"])("%s /billing/* passes even when expired", (method) => {
    const { next, res } = run({
      method,
      path: "/billing/subscription",
      originalUrl: "/hotel-settings/billing/subscription",
      status: SubscriptionStatus.EXPIRED,
    });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("matches on originalUrl too, for a router mounted elsewhere", () => {
    const { next } = run({
      method: "POST",
      path: "/subscription",
      originalUrl: "/hotel-settings/billing/subscription",
      status: SubscriptionStatus.EXPIRED,
    });
    expect(next).toHaveBeenCalled();
  });
});

describe("PAST_DUE is the grace window, not a suspension", () => {
  it.each(["GET", "POST", "PATCH", "DELETE"])("%s is still served", (method) => {
    const { next, res } = run({ method, path: "/messages", status: SubscriptionStatus.PAST_DUE });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("TRIALING is fully served", () => {
  it("can write", () => {
    const { next } = run({ method: "POST", path: "/messages", status: SubscriptionStatus.TRIALING });
    expect(next).toHaveBeenCalled();
  });
});

describe("CANCELED is treated as suspended", () => {
  it("blocks writes", () => {
    const { res } = run({ method: "POST", path: "/messages", status: SubscriptionStatus.CANCELED });
    expect(res.status).toHaveBeenCalledWith(402);
  });
});

describe("no subscription on the request", () => {
  it("defers rather than deciding — that is auth's job, not the paywall's", () => {
    const { next, res } = run({ method: "POST", path: "/messages", status: null });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
