/**
 * Unit tests for instagram.auth.service — Business Login for Instagram flow.
 * Covers the three points corrected against Meta's authoritative docs:
 *   - Point 4: token exchange response is wrapped in a data array
 *   - Point 5: /me fields are user_id,username (not id,name)
 *   - Point 3: subscribeInstagramWebhook is called at connect time
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock fetch globally ───────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── mock prisma ───────────────────────────────────────────────────────────────

vi.mock("../db/connect", () => ({
  default: {
    hotelConfig: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

// ── mock encryption ───────────────────────────────────────────────────────────

vi.mock("./instagram.service", () => ({
  encryptInstagramToken: vi.fn((t: string) => `enc:${t}`),
}));

// ── env vars ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INSTAGRAM_APP_ID     = "850762578056255";
  process.env.INSTAGRAM_APP_SECRET = "test-secret-32chars-padding-here";
  process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY = "a".repeat(64); // 32-byte hex
});

import {
  exchangeInstagramCode,
  getLongLivedToken,
  getInstagramAccountInfo,
  subscribeInstagramWebhook,
  connectInstagram,
} from "./instagram.auth.service";

// ── helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: any, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

// ── exchangeInstagramCode ─────────────────────────────────────────────────────

describe("exchangeInstagramCode", () => {
  it("parses data-array response shape from api.instagram.com", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({
      data: [{ access_token: "short-token", user_id: "12345678", permissions: ["instagram_business_basic"] }],
    }));

    const result = await exchangeInstagramCode("auth-code", "https://vaketta.com/dashboard/configuration");

    expect(result).toEqual({ accessToken: "short-token", userId: "12345678" });

    // Confirm POSTed to the correct endpoint
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.instagram.com/oauth/access_token");
    expect((opts as RequestInit).method).toBe("POST");
    const body = new URLSearchParams((opts as RequestInit).body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
  });

  it("also handles flat response shape (graceful fallback)", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({
      access_token: "flat-token",
      user_id:      "99999",
    }));

    const result = await exchangeInstagramCode("code2", "https://vaketta.com/dashboard/configuration");
    expect(result).toEqual({ accessToken: "flat-token", userId: "99999" });
  });

  it("throws with error_message from Meta on failure", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(
      { error_message: "Invalid verification code format." },
      false, 400,
    ));

    await expect(exchangeInstagramCode("bad-code", "https://vaketta.com/dashboard/configuration"))
      .rejects.toThrow("Invalid verification code format.");
  });
});

// ── getInstagramAccountInfo ───────────────────────────────────────────────────

describe("getInstagramAccountInfo", () => {
  it("requests user_id,username and returns them correctly", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({
      user_id:  "17841400123456789",
      username: "maadathilresort",
    }));

    const result = await getInstagramAccountInfo("long-token");

    expect(result).toEqual({ id: "17841400123456789", username: "maadathilresort" });

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.hostname).toBe("graph.instagram.com");
    expect(parsed.pathname).toBe("/me");
    expect(parsed.searchParams.get("fields")).toBe("user_id,username");
  });

  it("throws when user_id is absent from response", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ username: "test" }));
    await expect(getInstagramAccountInfo("token")).rejects.toThrow("Failed to fetch Instagram account info");
  });
});

// ── subscribeInstagramWebhook ─────────────────────────────────────────────────

describe("subscribeInstagramWebhook", () => {
  it("POSTs to /{ig-user-id}/subscribed_apps with subscribed_fields=messages", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ success: true }));

    await subscribeInstagramWebhook("17841400123456789", "short-token");

    const [url, opts] = mockFetch.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.hostname).toBe("graph.instagram.com");
    expect(parsed.pathname).toContain("17841400123456789");
    expect(parsed.pathname).toContain("subscribed_apps");
    expect(parsed.searchParams.get("subscribed_fields")).toBe("messages");
    expect(parsed.searchParams.get("access_token")).toBe("short-token");
    expect((opts as RequestInit).method).toBe("POST");
  });

  it("throws when Meta returns an error", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(
      { error: { message: "App not subscribed to IG webhooks" } },
      false, 400,
    ));

    await expect(subscribeInstagramWebhook("uid", "tok"))
      .rejects.toThrow("App not subscribed to IG webhooks");
  });
});

// ── connectInstagram (integration) ───────────────────────────────────────────

describe("connectInstagram", () => {
  it("calls webhook subscription BEFORE long-lived token exchange, in order", async () => {
    // 1. exchangeInstagramCode → data-array response
    mockFetch.mockReturnValueOnce(jsonResponse({
      data: [{ access_token: "short-tok", user_id: "uid-123" }],
    }));
    // 2. subscribeInstagramWebhook
    mockFetch.mockReturnValueOnce(jsonResponse({ success: true }));
    // 3. getLongLivedToken
    mockFetch.mockReturnValueOnce(jsonResponse({ access_token: "long-tok" }));
    // 4. getInstagramAccountInfo
    mockFetch.mockReturnValueOnce(jsonResponse({ user_id: "uid-123", username: "hotel" }));

    const result = await connectInstagram("hotel-1", "code", "https://vaketta.com/dashboard/configuration");

    expect(result).toEqual({ instagramBusinessAccountId: "uid-123", username: "hotel" });

    // Confirm call order: token exchange → subscribe → long-lived → me
    const urls = mockFetch.mock.calls.map(([url]) => {
      const u = new URL(url as string);
      return `${u.hostname}${u.pathname}`;
    });
    expect(urls[0]).toBe("api.instagram.com/oauth/access_token");
    expect(urls[1]).toContain("subscribed_apps");   // webhook subscription second
    expect(urls[2]).toContain("access_token");       // long-lived exchange third
    expect(urls[3]).toContain("/me");                // account info last
  });
});
