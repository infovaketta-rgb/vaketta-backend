/**
 * Tests for instagramEmbedUrl handling in settings.service.ts:
 *   (a) empty saved value → computed default used
 *   (b) valid saved override → used as-is
 *   (c) invalid save attempt → rejected with error
 * Also covers validateInstagramEmbedUrl directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/connect", () => ({
  default: {
    hotelConfig:      { findUnique: vi.fn().mockResolvedValue(null) },
    platformSettings: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));
vi.mock("../queue/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));
vi.mock("../utils/encryption.utils", () => ({
  encryptInstagramToken: vi.fn(),
  encryptWhatsAppToken:  vi.fn(),
  decryptWhatsAppToken:  vi.fn(),
}));
vi.mock("./whatsapp.send.service", () => ({
  invalidateCredentialsCache: vi.fn(),
}));

import {
  validateInstagramEmbedUrl,
  getInstagramConfig,
  updatePlatformSettings,
} from "./settings.service";
import prisma from "../db/connect";

const platformSettings = (prisma as any).platformSettings as {
  findUnique: ReturnType<typeof vi.fn>;
  upsert:     ReturnType<typeof vi.fn>;
};

const VALID_URL =
  "https://www.instagram.com/oauth/authorize?client_id=850762578056255&redirect_uri=https%3A%2F%2Fvaketta.com%2Fdashboard%2Fconfiguration&scope=instagram_business_basic%2Cinstagram_business_manage_messages&response_type=code";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INSTAGRAM_APP_ID = "850762578056255";
});

// ── validateInstagramEmbedUrl ─────────────────────────────────────────────────

describe("validateInstagramEmbedUrl", () => {
  it("accepts a fully valid URL", () => {
    expect(validateInstagramEmbedUrl(VALID_URL)).toBeNull();
  });

  it("rejects a non-URL string", () => {
    expect(validateInstagramEmbedUrl("not-a-url")).toMatch(/valid URL/i);
  });

  it("rejects wrong host", () => {
    const bad = VALID_URL.replace("www.instagram.com", "graph.facebook.com");
    expect(validateInstagramEmbedUrl(bad)).toMatch(/www\.instagram\.com/);
  });

  it("rejects wrong path", () => {
    const bad = VALID_URL.replace("/oauth/authorize", "/login");
    expect(validateInstagramEmbedUrl(bad)).toMatch(/\/oauth\/authorize/);
  });

  it("rejects missing client_id", () => {
    const url = new URL(VALID_URL);
    url.searchParams.delete("client_id");
    expect(validateInstagramEmbedUrl(url.toString())).toMatch(/client_id/);
  });

  it("rejects missing redirect_uri", () => {
    const url = new URL(VALID_URL);
    url.searchParams.delete("redirect_uri");
    expect(validateInstagramEmbedUrl(url.toString())).toMatch(/redirect_uri/);
  });

  it("rejects response_type !== code", () => {
    const url = new URL(VALID_URL);
    url.searchParams.set("response_type", "token");
    expect(validateInstagramEmbedUrl(url.toString())).toMatch(/response_type/);
  });

  it("rejects missing scope", () => {
    const url = new URL(VALID_URL);
    url.searchParams.delete("scope");
    expect(validateInstagramEmbedUrl(url.toString())).toMatch(/scope/);
  });
});

// ── getInstagramConfig — instagramEmbedUrl behaviour ─────────────────────────

describe("getInstagramConfig — instagramEmbedUrl", () => {
  it("(a) returns server-computed default when saved value is empty", async () => {
    platformSettings.findUnique.mockResolvedValue({ instagramEmbedUrl: "", metaApiVersion: "v25.0" });

    const cfg = await getInstagramConfig("hotel-1");

    // Must be a valid URL built from INSTAGRAM_APP_ID env var
    expect(cfg.instagramEmbedUrl).toContain("www.instagram.com/oauth/authorize");
    expect(cfg.instagramEmbedUrl).toContain("850762578056255");
    expect(cfg.instagramEmbedUrl).toContain("response_type=code");
    expect(cfg.instagramEmbedUrl).toContain("instagram_business_basic");
    expect(validateInstagramEmbedUrl(cfg.instagramEmbedUrl)).toBeNull();
  });

  it("(a) returns computed default when saved value is null/absent", async () => {
    platformSettings.findUnique.mockResolvedValue(null);

    const cfg = await getInstagramConfig("hotel-1");
    expect(cfg.instagramEmbedUrl).toContain("www.instagram.com/oauth/authorize");
  });

  it("(b) returns saved override when it is valid", async () => {
    platformSettings.findUnique.mockResolvedValue({ instagramEmbedUrl: VALID_URL, metaApiVersion: "v25.0" });

    const cfg = await getInstagramConfig("hotel-1");
    expect(cfg.instagramEmbedUrl).toBe(VALID_URL);
  });

  it("(b→a fallback) falls back to computed default when saved URL is invalid", async () => {
    platformSettings.findUnique.mockResolvedValue({
      instagramEmbedUrl: "https://graph.facebook.com/bad",
      metaApiVersion:    "v25.0",
    });

    const cfg = await getInstagramConfig("hotel-1");
    // Should NOT use the invalid saved value
    expect(cfg.instagramEmbedUrl).not.toContain("graph.facebook.com");
    expect(cfg.instagramEmbedUrl).toContain("www.instagram.com/oauth/authorize");
  });
});

// ── updatePlatformSettings — instagramEmbedUrl validation ────────────────────

describe("updatePlatformSettings — instagramEmbedUrl", () => {
  beforeEach(() => {
    platformSettings.upsert.mockResolvedValue({ instagramEmbedUrl: VALID_URL });
  });

  it("saves a valid URL without error", async () => {
    await expect(updatePlatformSettings({ instagramEmbedUrl: VALID_URL })).resolves.toBeDefined();
    expect(platformSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ instagramEmbedUrl: VALID_URL }),
    }));
  });

  it("(c) rejects an invalid URL with a clear error", async () => {
    await expect(
      updatePlatformSettings({ instagramEmbedUrl: "https://graph.facebook.com/bad" })
    ).rejects.toThrow("Invalid Instagram Embed URL");
    expect(platformSettings.upsert).not.toHaveBeenCalled();
  });

  it("(c) rejects missing required params with a clear error", async () => {
    const noScope = new URL(VALID_URL);
    noScope.searchParams.delete("scope");
    await expect(
      updatePlatformSettings({ instagramEmbedUrl: noScope.toString() })
    ).rejects.toThrow("Invalid Instagram Embed URL");
  });

  it("allows saving an empty string (clears the override, reverts to computed default)", async () => {
    await expect(updatePlatformSettings({ instagramEmbedUrl: "" })).resolves.toBeDefined();
    expect(platformSettings.upsert).toHaveBeenCalled();
  });
});
