/**
 * Tests for the Instagram config_id-based connect flow routes:
 *   - POST /api/instagram/exchange-code — exchanges the FB-Login-for-Business code
 *     server-side, then connects (single page) or returns pages for selection (multi).
 *   - POST /api/instagram/connect — second step for the multi-page case, reusing the
 *     already-long-lived token (no redundant re-exchange).
 *
 * Same no-supertest style as the controller tests: the exported Express Router is
 * invoked directly as a request handler with mocked req/res; the auth service is
 * mocked. The router itself is real, so route matching + body handling are exercised.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/instagram.auth.service", () => ({
  exchangeInstagramCodeForToken: vi.fn(),
  exchangeForLongLivedToken:     vi.fn(),
  getPagesWithInstagram:         vi.fn(),
  connectInstagramViaPage:       vi.fn(),
  subscribePageToWebhook:        vi.fn(),
}));

import router from "./instagram.connect.routes";
import {
  exchangeInstagramCodeForToken,
  exchangeForLongLivedToken,
  getPagesWithInstagram,
  connectInstagramViaPage,
  subscribePageToWebhook,
} from "../services/instagram.auth.service";

const exchangeCode  = exchangeInstagramCodeForToken as ReturnType<typeof vi.fn>;
const longLived     = exchangeForLongLivedToken     as ReturnType<typeof vi.fn>;
const getPages      = getPagesWithInstagram         as ReturnType<typeof vi.fn>;
const connectViaPage = connectInstagramViaPage      as ReturnType<typeof vi.fn>;
const subscribe     = subscribePageToWebhook        as ReturnType<typeof vi.fn>;

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json   = vi.fn((b: any) => { res.body = b; return res; });
  return res;
}

/** Drive the real Express router as a handler. Resolves once res.json fires. */
function call(method: string, url: string, body: any, hotelId = "hotel-1") {
  return new Promise<any>((resolve, reject) => {
    const res = mockRes();
    const origJson = res.json;
    res.json = vi.fn((b: any) => { origJson(b); resolve(res); return res; });
    const req: any = { method, url, body, user: { hotelId } };
    (router as any)(req, res, (err: any) => (err ? reject(err) : resolve(res)));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/instagram/exchange-code", () => {
  it("400s when code is missing", async () => {
    const res = await call("POST", "/exchange-code", {});
    expect(res.statusCode).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("single page → exchanges code, connects, subscribes webhook", async () => {
    exchangeCode.mockResolvedValue("short-token");
    longLived.mockResolvedValue("long-token");
    getPages.mockResolvedValue([
      { id: "page-1", name: "Hotel Page", accessToken: "pat-1", igAccount: { id: "ig-1", name: "Hotel IG" } },
    ]);
    connectViaPage.mockResolvedValue({ instagramBusinessAccountId: "ig-1" });
    subscribe.mockResolvedValue(undefined);

    const res = await call("POST", "/exchange-code", { code: "auth-code", redirectUri: "https://x" });

    // server-side exchange, never the client
    expect(exchangeCode).toHaveBeenCalledWith("auth-code", "https://x");
    expect(longLived).toHaveBeenCalledWith("short-token");
    // hotelId comes from JWT (req.user), not the body
    expect(connectViaPage).toHaveBeenCalledWith("hotel-1", "page-1", "pat-1");
    expect(subscribe).toHaveBeenCalledWith("hotel-1", "page-1", "pat-1");
    expect(res.body).toEqual({ success: true, instagramBusinessAccountId: "ig-1" });
  });

  it("multiple pages → returns needsSelection + pages + long-lived token, does NOT connect", async () => {
    exchangeCode.mockResolvedValue("short-token");
    longLived.mockResolvedValue("long-token");
    getPages.mockResolvedValue([
      { id: "page-1", name: "A", accessToken: "pat-1", igAccount: { id: "ig-1", name: "A" } },
      { id: "page-2", name: "B", accessToken: "pat-2", igAccount: { id: "ig-2", name: "B" } },
    ]);

    const res = await call("POST", "/exchange-code", { code: "auth-code" });

    expect(res.body.needsSelection).toBe(true);
    expect(res.body.pages).toHaveLength(2);
    expect(res.body.longLivedToken).toBe("long-token");
    expect(connectViaPage).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("no linked IG accounts → 400 with a clear message", async () => {
    exchangeCode.mockResolvedValue("short-token");
    longLived.mockResolvedValue("long-token");
    getPages.mockResolvedValue([]);

    const res = await call("POST", "/exchange-code", { code: "auth-code" });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/No Instagram Business accounts/i);
  });

  it("502s when the code exchange fails (single-use code spent / invalid)", async () => {
    exchangeCode.mockRejectedValue(new Error("Failed to exchange code for access token"));
    const res = await call("POST", "/exchange-code", { code: "bad" });
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/exchange code/i);
  });
});

describe("POST /api/instagram/connect (multi-page second step)", () => {
  it("400s when pageId or longLivedToken is missing", async () => {
    const res = await call("POST", "/connect", { pageId: "page-1" });
    expect(res.statusCode).toBe(400);
    expect(getPages).not.toHaveBeenCalled();
  });

  it("connects the chosen page using the long-lived token (no re-exchange)", async () => {
    getPages.mockResolvedValue([
      { id: "page-1", name: "A", accessToken: "pat-1", igAccount: { id: "ig-1", name: "A" } },
      { id: "page-2", name: "B", accessToken: "pat-2", igAccount: { id: "ig-2", name: "B" } },
    ]);
    connectViaPage.mockResolvedValue({ instagramBusinessAccountId: "ig-2" });
    subscribe.mockResolvedValue(undefined);

    const res = await call("POST", "/connect", { pageId: "page-2", longLivedToken: "long-token" });

    // no second authorization_code exchange
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(longLived).not.toHaveBeenCalled();
    expect(connectViaPage).toHaveBeenCalledWith("hotel-1", "page-2", "pat-2");
    expect(res.body).toEqual({ success: true, instagramBusinessAccountId: "ig-2" });
  });

  it("400s when the chosen page is not in the list", async () => {
    getPages.mockResolvedValue([
      { id: "page-1", name: "A", accessToken: "pat-1", igAccount: { id: "ig-1", name: "A" } },
    ]);
    const res = await call("POST", "/connect", { pageId: "page-X", longLivedToken: "long-token" });
    expect(res.statusCode).toBe(400);
    expect(connectViaPage).not.toHaveBeenCalled();
  });
});
