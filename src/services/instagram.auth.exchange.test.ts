/**
 * Unit tests for exchangeInstagramCodeForToken — redirect_uri handling for the
 * JS-SDK popup code flow. The exchange ALWAYS sends redirect_uri (mirroring
 * WhatsApp's working flow): a present-but-empty `redirect_uri: ""` matches the SDK
 * popup, whereas OMITTING the key triggers Meta's OAuthException 100 / subcode 36008
 * ("redirect_uri is identical…"). Verified live: omitting it failed; this is the fix.
 *
 * fetch + prisma are stubbed; no network or DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// getMetaVersion() reads platformSettings; stub prisma so it resolves a version.
vi.mock("../db/connect", () => ({
  default: {
    platformSettings: {
      findUnique: vi.fn(async () => ({ metaApiVersion: "v25.0" })),
    },
  },
}));
// connectInstagramViaPage imports encryptInstagramToken from here — keep it simple.
vi.mock("./instagram.service", () => ({ encryptInstagramToken: (s: string) => `enc:${s}` }));

import { exchangeInstagramCodeForToken } from "./instagram.auth.service";

const OK_TOKEN = { access_token: "user-token-123" };

function mockFetchOnce(json: any, ok = true, status = 200) {
  return vi.fn(async (_url: any, _init?: any) => ({ ok, status, json: async () => json }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FACEBOOK_APP_ID     = "app-id";
  process.env.FACEBOOK_APP_SECRET = "app-secret";
  // Default: no Instagram-specific creds → exchange falls back to FACEBOOK_APP_*.
  delete process.env.INSTAGRAM_APP_ID;
  delete process.env.INSTAGRAM_APP_SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exchangeInstagramCodeForToken — redirect_uri handling", () => {
  it("INCLUDES redirect_uri as a present-but-empty string for the SDK popup flow", async () => {
    const fetchMock = mockFetchOnce(OK_TOKEN);
    vi.stubGlobal("fetch", fetchMock);

    const token = await exchangeInstagramCodeForToken("auth-code", "");

    expect(token).toBe("user-token-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as any).body);
    expect(body).toMatchObject({
      client_id:     "app-id",
      client_secret: "app-secret",
      grant_type:    "authorization_code",
      code:          "auth-code",
    });
    // present (not omitted), empty value — matches the popup, avoids 36008.
    expect(body).toHaveProperty("redirect_uri");
    expect(body.redirect_uri).toBe("");
  });

  it("INCLUDES redirect_uri (empty) when none is passed at all (defaults to empty)", async () => {
    const fetchMock = mockFetchOnce(OK_TOKEN);
    vi.stubGlobal("fetch", fetchMock);

    await exchangeInstagramCodeForToken("auth-code");

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as any).body);
    expect(body).toHaveProperty("redirect_uri");
    expect(body.redirect_uri).toBe("");
  });

  it("forwards a non-empty redirect_uri verbatim (manual-redirect flow)", async () => {
    const fetchMock = mockFetchOnce(OK_TOKEN);
    vi.stubGlobal("fetch", fetchMock);

    await exchangeInstagramCodeForToken("auth-code", "https://vaketta.com/dashboard/configuration");

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as any).body);
    expect(body.redirect_uri).toBe("https://vaketta.com/dashboard/configuration");
  });

  it("throws Meta's error message when the exchange is rejected", async () => {
    const fetchMock = mockFetchOnce(
      { error: { message: "Error validating verification code." } },
      false,
      400,
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeInstagramCodeForToken("bad-code", "")).rejects.toThrow(
      /Error validating verification code/,
    );
  });
});

describe("exchangeInstagramCodeForToken — credential source", () => {
  it("uses INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET when set (not the Facebook app creds)", async () => {
    process.env.INSTAGRAM_APP_ID     = "ig-app-id";
    process.env.INSTAGRAM_APP_SECRET = "ig-app-secret";
    const fetchMock = mockFetchOnce(OK_TOKEN);
    vi.stubGlobal("fetch", fetchMock);

    await exchangeInstagramCodeForToken("auth-code", "");

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as any).body);
    expect(body.client_id).toBe("ig-app-id");
    expect(body.client_secret).toBe("ig-app-secret");
  });

  it("falls back to FACEBOOK_APP_* when Instagram creds are absent", async () => {
    // (INSTAGRAM_APP_* are deleted in beforeEach)
    const fetchMock = mockFetchOnce(OK_TOKEN);
    vi.stubGlobal("fetch", fetchMock);

    await exchangeInstagramCodeForToken("auth-code", "");

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as any).body);
    expect(body.client_id).toBe("app-id");
    expect(body.client_secret).toBe("app-secret");
  });
});
