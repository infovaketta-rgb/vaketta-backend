/**
 * Unit tests for exchangeInstagramCodeForToken — specifically the redirect_uri
 * handling for the JS-SDK popup code flow:
 *   - empty redirectUri  → POST body OMITS redirect_uri entirely (Meta rejects an
 *     SDK-internal/non-matching redirect_uri with "redirect_uri is identical…").
 *   - non-empty redirectUri → included verbatim (future manual-redirect flow).
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exchangeInstagramCodeForToken — redirect_uri handling", () => {
  it("OMITS redirect_uri from the POST body when redirectUri is empty (SDK popup flow)", async () => {
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
    expect(body).not.toHaveProperty("redirect_uri");
  });

  it("OMITS redirect_uri when none is passed at all (defaults to empty)", async () => {
    const fetchMock = mockFetchOnce(OK_TOKEN);
    vi.stubGlobal("fetch", fetchMock);

    await exchangeInstagramCodeForToken("auth-code");

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as any).body);
    expect(body).not.toHaveProperty("redirect_uri");
  });

  it("INCLUDES redirect_uri verbatim when a non-empty value is provided", async () => {
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
