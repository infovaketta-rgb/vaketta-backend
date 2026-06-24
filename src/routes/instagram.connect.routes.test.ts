/**
 * Tests for the Instagram "Facebook Login for Business / IG_API_ONBOARDING" connect
 * routes (token flow — NO server-side code exchange):
 *   - POST /api/instagram/connect-with-token — takes the user access token the client
 *     parsed from the login redirect fragment, runs /me/accounts, then connects (single
 *     page) or returns pages for selection (multi).
 *   - POST /api/instagram/connect — second step for the multi-page case, reusing the
 *     same access token + the chosen pageId.
 *
 * No-supertest style: the exported Express Router is invoked directly with mocked
 * req/res; the auth service is mocked. Route matching + body handling are exercised.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/instagram.auth.service", () => ({
  getPagesWithInstagram:   vi.fn(),
  connectInstagramViaPage: vi.fn(),
  subscribePageToWebhook:  vi.fn(),
}));

import router from "./instagram.connect.routes";
import {
  getPagesWithInstagram,
  connectInstagramViaPage,
  subscribePageToWebhook,
} from "../services/instagram.auth.service";

const getPages       = getPagesWithInstagram   as ReturnType<typeof vi.fn>;
const connectViaPage = connectInstagramViaPage as ReturnType<typeof vi.fn>;
const subscribe      = subscribePageToWebhook  as ReturnType<typeof vi.fn>;

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

describe("POST /api/instagram/connect-with-token", () => {
  it("400s when accessToken is missing", async () => {
    const res = await call("POST", "/connect-with-token", {});
    expect(res.statusCode).toBe(400);
    expect(getPages).not.toHaveBeenCalled();
  });

  it("single page → calls /me/accounts with the token, connects, subscribes webhook", async () => {
    getPages.mockResolvedValue([
      { id: "page-1", name: "Hotel Page", accessToken: "pat-1", igAccount: { id: "ig-1", name: "Hotel IG" } },
    ]);
    connectViaPage.mockResolvedValue({ instagramBusinessAccountId: "ig-1" });
    subscribe.mockResolvedValue(undefined);

    const res = await call("POST", "/connect-with-token", { accessToken: "user-token-abc" });

    // /me/accounts called with the token sent by the client (no code exchange)
    expect(getPages).toHaveBeenCalledWith("user-token-abc");
    // hotelId comes from JWT (req.user), not the body
    expect(connectViaPage).toHaveBeenCalledWith("hotel-1", "page-1", "pat-1");
    expect(subscribe).toHaveBeenCalledWith("hotel-1", "page-1", "pat-1");
    expect(res.body).toEqual({ success: true, instagramBusinessAccountId: "ig-1" });
  });

  it("multiple pages → returns needsSelection + pages + the token, does NOT connect", async () => {
    getPages.mockResolvedValue([
      { id: "page-1", name: "A", accessToken: "pat-1", igAccount: { id: "ig-1", name: "A" } },
      { id: "page-2", name: "B", accessToken: "pat-2", igAccount: { id: "ig-2", name: "B" } },
    ]);

    const res = await call("POST", "/connect-with-token", { accessToken: "user-token-abc" });

    expect(res.body.needsSelection).toBe(true);
    expect(res.body.pages).toHaveLength(2);
    expect(res.body.accessToken).toBe("user-token-abc");
    expect(connectViaPage).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("no linked IG accounts → 400 with a clear message", async () => {
    getPages.mockResolvedValue([]);
    const res = await call("POST", "/connect-with-token", { accessToken: "user-token-abc" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/No Instagram Business accounts/i);
  });

  it("502s when the Graph call throws (e.g. invalid token)", async () => {
    getPages.mockRejectedValue(new Error("Failed to fetch Facebook pages"));
    const res = await call("POST", "/connect-with-token", { accessToken: "bad-token" });
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/fetch Facebook pages/i);
  });
});

describe("POST /api/instagram/connect (multi-page second step)", () => {
  it("400s when pageId or accessToken is missing", async () => {
    const res = await call("POST", "/connect", { pageId: "page-1" });
    expect(res.statusCode).toBe(400);
    expect(getPages).not.toHaveBeenCalled();
  });

  it("connects the chosen page using the provided access token", async () => {
    getPages.mockResolvedValue([
      { id: "page-1", name: "A", accessToken: "pat-1", igAccount: { id: "ig-1", name: "A" } },
      { id: "page-2", name: "B", accessToken: "pat-2", igAccount: { id: "ig-2", name: "B" } },
    ]);
    connectViaPage.mockResolvedValue({ instagramBusinessAccountId: "ig-2" });
    subscribe.mockResolvedValue(undefined);

    const res = await call("POST", "/connect", { pageId: "page-2", accessToken: "user-token-abc" });

    expect(getPages).toHaveBeenCalledWith("user-token-abc");
    expect(connectViaPage).toHaveBeenCalledWith("hotel-1", "page-2", "pat-2");
    expect(res.body).toEqual({ success: true, instagramBusinessAccountId: "ig-2" });
  });

  it("400s when the chosen page is not in the list", async () => {
    getPages.mockResolvedValue([
      { id: "page-1", name: "A", accessToken: "pat-1", igAccount: { id: "ig-1", name: "A" } },
    ]);
    const res = await call("POST", "/connect", { pageId: "page-X", accessToken: "user-token-abc" });
    expect(res.statusCode).toBe(400);
    expect(connectViaPage).not.toHaveBeenCalled();
  });
});
