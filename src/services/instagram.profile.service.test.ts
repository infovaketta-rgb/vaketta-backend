/**
 * Tests for Instagram guest profile enrichment.
 *
 * Contract locked in here:
 *  - classifyGraphError maps every documented Graph condition to the status we
 *    persist + whether BullMQ should retry. Permanent conditions must NOT be
 *    retryable, otherwise a job burns all 3 attempts on something that can
 *    never succeed.
 *  - The worker body re-checks the TTL in the DB and returns early when a
 *    concurrent run already refreshed the guest (the queue's time-bucketed
 *    jobId is only a coarse dedup; this is the real guard).
 *  - The avatar sha256 short-circuit: identical bytes → no uploadToR2 call and
 *    no delete, so a daily refresh never creates an orphan R2 object.
 *  - A permanent failure still stamps igProfileFetchedAt, which is what stops
 *    us hammering Graph once per message for a guest who will never resolve.
 *  - Guest.name is staff-owned and is never written by enrichment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const guestFindUnique = vi.fn();
const guestUpdate     = vi.fn().mockResolvedValue({});
vi.mock("../db/connect", () => ({
  default: {
    guest: {
      findUnique: (...a: any[]) => guestFindUnique(...a),
      update:     (...a: any[]) => guestUpdate(...a),
    },
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { child: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

const getMetaVersion = vi.fn().mockResolvedValue("v25.0");
vi.mock("../utils/metaApi.utils", () => ({
  getMetaVersion: (...a: any[]) => getMetaVersion(...a),
  // Pass-through: retry policy itself is covered by the send-service tests.
  withRetry: (fn: () => Promise<unknown>) => fn(),
}));

const resolveInstagramCredentials = vi.fn().mockResolvedValue({
  accessToken: "IGAA_test_token",
  igAccountId: "17841400000000000",
  mockMode:    false,
});
vi.mock("./instagram.send.service", () => ({
  resolveInstagramCredentials: (...a: any[]) => resolveInstagramCredentials(...a),
}));

const uploadToR2     = vi.fn();
const deleteFromR2   = vi.fn().mockResolvedValue(undefined);
const isR2Configured = vi.fn().mockReturnValue(true);
vi.mock("./r2.service", () => ({
  uploadToR2:     (...a: any[]) => uploadToR2(...a),
  deleteFromR2:   (...a: any[]) => deleteFromR2(...a),
  isR2Configured: (...a: any[]) => isR2Configured(...a),
}));

const queueAdd = vi.fn().mockResolvedValue({});
vi.mock("../queue/instagramProfile.queue", () => ({
  instagramProfileQueue: { add: (...a: any[]) => queueAdd(...a) },
}));

import {
  classifyGraphError,
  fetchInstagramUserProfile,
  mirrorInstagramAvatar,
  runInstagramProfileJob,
  maybeEnqueueInstagramProfileJob,
} from "./instagram.profile.service";

const GUEST_ID = "guest_1";
const HOTEL_ID = "hotel_1";
const IGSID    = "996345286534670";

// A 1x1 JPEG — enough for the byte-hashing paths.
const AVATAR_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
  "base64",
);

function mockAvatarFetch(bytes: Buffer = AVATAR_BYTES, contentType = "image/jpeg") {
  return vi.fn().mockResolvedValue({
    ok:      true,
    status:  200,
    headers: new Headers({ "content-type": contentType, "content-length": String(bytes.byteLength) }),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getMetaVersion.mockResolvedValue("v25.0");
  isR2Configured.mockReturnValue(true);
  resolveInstagramCredentials.mockResolvedValue({
    accessToken: "IGAA_test_token", igAccountId: "17841400000000000", mockMode: false,
  });
  guestUpdate.mockResolvedValue({});
  delete process.env.MOCK_INSTAGRAM_PROFILE;
  delete process.env.INSTAGRAM_PROFILE_ENRICHMENT_ENABLED;
  delete process.env.INSTAGRAM_PROFILE_TTL_HOURS;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── A3: classifyGraphError — one case per row of the spec table ───────────────

describe("classifyGraphError", () => {
  it("maps a consent message to NO_CONSENT, not retryable", () => {
    const out = classifyGraphError(400, {
      error: { message: "User has not granted consent to access this profile", code: 10 },
    });
    expect(out).toEqual({ status: "NO_CONSENT", retryable: false });
  });

  it("maps code 190 to TOKEN_EXPIRED, not retryable", () => {
    const out = classifyGraphError(400, {
      error: { message: "Error validating access token: Session has expired", code: 190 },
    });
    expect(out).toEqual({ status: "TOKEN_EXPIRED", retryable: false });
  });

  it("maps code 100 to NOT_FOUND, not retryable", () => {
    const out = classifyGraphError(400, { error: { message: "Invalid parameter", code: 100 } });
    expect(out).toEqual({ status: "NOT_FOUND", retryable: false });
  });

  it("maps 'does not exist' to NOT_FOUND (also what a blocked guest looks like)", () => {
    const out = classifyGraphError(404, {
      error: { message: "Unsupported get request. Object with ID '123' does not exist", code: 803 },
    });
    expect(out).toEqual({ status: "NOT_FOUND", retryable: false });
  });

  it("maps 'Unsupported get request' to NOT_FOUND", () => {
    const out = classifyGraphError(400, { error: { message: "Unsupported get request.", code: 803 } });
    expect(out).toEqual({ status: "NOT_FOUND", retryable: false });
  });

  it("marks HTTP 429 retryable", () => {
    expect(classifyGraphError(429, { error: { message: "rate limited", code: 613 } }))
      .toEqual({ status: "ERROR", retryable: true });
  });

  it.each([4, 17, 32])("marks throttling code %i retryable", (code) => {
    expect(classifyGraphError(400, { error: { message: "Application request limit reached", code } }))
      .toEqual({ status: "ERROR", retryable: true });
  });

  it("marks HTTP >= 500 retryable", () => {
    expect(classifyGraphError(503, { error: { message: "Service unavailable", code: 2 } }))
      .toEqual({ status: "ERROR", retryable: true });
  });

  it("marks a network error / abort (null status) retryable", () => {
    expect(classifyGraphError(null, null)).toEqual({ status: "ERROR", retryable: true });
  });

  it("maps anything else to ERROR, not retryable", () => {
    expect(classifyGraphError(400, { error: { message: "Some other problem", code: 999 } }))
      .toEqual({ status: "ERROR", retryable: false });
  });
});

// ── A3: fetch shape ───────────────────────────────────────────────────────────

describe("fetchInstagramUserProfile", () => {
  it("calls graph.instagram.com with a Bearer header and no token in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        name: "Aisha", username: "aisha.travels", profile_pic: "https://scontent.cdninstagram.com/x.jpg",
        follower_count: 4210, is_user_follow_business: true, is_business_follow_user: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const profile = await fetchInstagramUserProfile({
      igsid: IGSID, accessToken: "IGAA_secret", version: "v25.0",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("https://graph.instagram.com/v25.0/996345286534670");
    expect(url).not.toContain("IGAA_secret");
    expect(url).not.toContain("access_token");
    expect(init.headers.Authorization).toBe("Bearer IGAA_secret");

    expect(profile).toEqual({
      name: "Aisha", username: "aisha.travels",
      profilePic: "https://scontent.cdninstagram.com/x.jpg",
      followerCount: 4210, isUserFollowBusiness: true, isBusinessFollowUser: false,
    });
  });

  it("returns a fixture without calling Graph when MOCK_INSTAGRAM_PROFILE=true", async () => {
    process.env.MOCK_INSTAGRAM_PROFILE = "true";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const profile = await fetchInstagramUserProfile({ igsid: IGSID, accessToken: "", version: "v25.0" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(profile.username).toBe("mock.instagram.user");
  });

  it("throws an error carrying status + graphBody for classification", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ error: { message: "Session has expired", code: 190 } }),
    }));

    await expect(
      fetchInstagramUserProfile({ igsid: IGSID, accessToken: "t", version: "v25.0" }),
    ).rejects.toMatchObject({ status: 400, graphBody: { error: { code: 190 } } });
  });
});

// ── A5: avatar mirroring ──────────────────────────────────────────────────────

describe("mirrorInstagramAvatar", () => {
  it("skips the upload entirely when the bytes hash to the stored value", async () => {
    // First mirror with no prior hash — establishes what the hash of these bytes is.
    vi.stubGlobal("fetch", mockAvatarFetch());
    uploadToR2.mockResolvedValue({ url: "https://media.vaketta.com/h/a.jpg", key: "h/a.jpg", mime: "image/jpeg", fileName: "a.jpg" });

    const first = await mirrorInstagramAvatar({
      hotelId: HOTEL_ID, picUrl: "https://scontent.cdninstagram.com/a.jpg", prevHash: null, prevKey: null,
    });
    expect(first).not.toBeNull();
    expect(uploadToR2).toHaveBeenCalledTimes(1);

    // Second run: same bytes, hash already stored → no upload, no delete.
    uploadToR2.mockClear();
    deleteFromR2.mockClear();
    vi.stubGlobal("fetch", mockAvatarFetch());

    const second = await mirrorInstagramAvatar({
      hotelId: HOTEL_ID,
      picUrl:  "https://scontent.cdninstagram.com/a-rotated-signature.jpg",
      prevHash: first!.hash,
      prevKey:  first!.key,
    });

    expect(second).toBeNull();
    expect(uploadToR2).not.toHaveBeenCalled();
    expect(deleteFromR2).not.toHaveBeenCalled();
  });

  it("uploads and best-effort deletes the superseded object when bytes change", async () => {
    vi.stubGlobal("fetch", mockAvatarFetch());
    uploadToR2.mockResolvedValue({ url: "https://media.vaketta.com/h/new.jpg", key: "h/new.jpg", mime: "image/jpeg", fileName: "new.jpg" });

    const out = await mirrorInstagramAvatar({
      hotelId: HOTEL_ID, picUrl: "https://scontent.cdninstagram.com/b.jpg",
      prevHash: "a-different-hash", prevKey: "h/old.jpg",
    });

    expect(out).toMatchObject({ url: "https://media.vaketta.com/h/new.jpg", key: "h/new.jpg" });
    expect(uploadToR2).toHaveBeenCalledTimes(1);
    expect(deleteFromR2).toHaveBeenCalledWith("h/old.jpg");
  });

  it("rejects a non-image content-type", async () => {
    vi.stubGlobal("fetch", mockAvatarFetch(AVATAR_BYTES, "text/html"));
    await expect(mirrorInstagramAvatar({
      hotelId: HOTEL_ID, picUrl: "https://x/a.jpg", prevHash: null, prevKey: null,
    })).rejects.toThrow(/content-type/);
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it("rejects an avatar over the 2 MB cap", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 1);
    vi.stubGlobal("fetch", mockAvatarFetch(big));
    await expect(mirrorInstagramAvatar({
      hotelId: HOTEL_ID, picUrl: "https://x/a.jpg", prevHash: null, prevKey: null,
    })).rejects.toThrow(/too large/);
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it("returns null (no upload) when there is no profile_pic", async () => {
    const out = await mirrorInstagramAvatar({
      hotelId: HOTEL_ID, picUrl: null, prevHash: null, prevKey: null,
    });
    expect(out).toBeNull();
    expect(uploadToR2).not.toHaveBeenCalled();
  });
});

// ── A4: worker job body ───────────────────────────────────────────────────────

describe("runInstagramProfileJob", () => {
  it("returns early without calling Graph when the DB TTL is still fresh", async () => {
    guestFindUnique.mockResolvedValue({
      id: GUEST_ID, hotelId: HOTEL_ID,
      igProfileFetchedAt: new Date(Date.now() - 60_000), // 1 min ago, TTL 24 h
      igProfilePicHash: null, igProfilePicKey: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runInstagramProfileJob({ guestId: GUEST_ID, hotelId: HOTEL_ID, igsid: IGSID });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveInstagramCredentials).not.toHaveBeenCalled();
    expect(guestUpdate).not.toHaveBeenCalled();
  });

  it("runs anyway when force is set (staff-triggered refresh bypasses the TTL)", async () => {
    guestFindUnique.mockResolvedValue({
      id: GUEST_ID, hotelId: HOTEL_ID,
      igProfileFetchedAt: new Date(), igProfilePicHash: null, igProfilePicKey: null,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ name: "Aisha", username: "aisha", profile_pic: null, follower_count: 10 }),
    }));

    await runInstagramProfileJob({ guestId: GUEST_ID, hotelId: HOTEL_ID, igsid: IGSID, force: true });

    expect(guestUpdate).toHaveBeenCalledTimes(1);
  });

  it("writes only ig* fields on success — never Guest.name", async () => {
    guestFindUnique.mockResolvedValue({
      id: GUEST_ID, hotelId: HOTEL_ID,
      igProfileFetchedAt: null, igProfilePicHash: null, igProfilePicKey: null,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        name: "Aisha", username: "aisha.travels", profile_pic: null,
        follower_count: 4210, is_user_follow_business: true, is_business_follow_user: false,
      }),
    }));

    await runInstagramProfileJob({ guestId: GUEST_ID, hotelId: HOTEL_ID, igsid: IGSID });

    const arg = guestUpdate.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: GUEST_ID }); // patched by exact id, never by phone
    expect(arg.data).toMatchObject({
      igName: "Aisha", igUsername: "aisha.travels", igFollowerCount: 4210,
      igFollowsBusiness: true, igBusinessFollows: false, igProfileStatus: "OK",
    });
    expect(arg.data.igProfileFetchedAt).toBeInstanceOf(Date);
    expect(arg.data).not.toHaveProperty("name");
  });

  it("records a NO_CONSENT failure and completes — no throw, no retry storm", async () => {
    guestFindUnique.mockResolvedValue({
      id: GUEST_ID, hotelId: HOTEL_ID,
      igProfileFetchedAt: null, igProfilePicHash: null, igProfilePicKey: null,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ error: { message: "User has not granted consent", code: 10 } }),
    }));

    await expect(
      runInstagramProfileJob({ guestId: GUEST_ID, hotelId: HOTEL_ID, igsid: IGSID }),
    ).resolves.toBeUndefined();

    const arg = guestUpdate.mock.calls[0]![0];
    expect(arg.data.igProfileStatus).toBe("NO_CONSENT");
    // igProfileFetchedAt MUST be stamped even on permanent failure — that is what
    // stops us re-querying Graph on every subsequent message.
    expect(arg.data.igProfileFetchedAt).toBeInstanceOf(Date);
  });

  it("throws on a retryable failure so BullMQ retries it", async () => {
    guestFindUnique.mockResolvedValue({
      id: GUEST_ID, hotelId: HOTEL_ID,
      igProfileFetchedAt: null, igProfilePicHash: null, igProfilePicKey: null,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 503, json: async () => ({ error: { message: "unavailable", code: 2 } }),
    }));

    await expect(
      runInstagramProfileJob({ guestId: GUEST_ID, hotelId: HOTEL_ID, igsid: IGSID }),
    ).rejects.toBeTruthy();
    expect(guestUpdate).not.toHaveBeenCalled();
  });

  it("keeps the text fields when avatar mirroring fails", async () => {
    guestFindUnique.mockResolvedValue({
      id: GUEST_ID, hotelId: HOTEL_ID,
      igProfileFetchedAt: null, igProfilePicHash: null, igProfilePicKey: null,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ name: "Aisha", username: "aisha", profile_pic: "https://scontent.cdninstagram.com/a.jpg", follower_count: 7 }),
      })
      .mockRejectedValueOnce(new Error("CDN unreachable"));
    vi.stubGlobal("fetch", fetchMock);

    await runInstagramProfileJob({ guestId: GUEST_ID, hotelId: HOTEL_ID, igsid: IGSID });

    const arg = guestUpdate.mock.calls[0]![0];
    expect(arg.data).toMatchObject({ igName: "Aisha", igProfileStatus: "OK" });
    expect(arg.data).not.toHaveProperty("igProfilePicUrl"); // left as-is
  });

  it("ignores a guest belonging to another hotel", async () => {
    guestFindUnique.mockResolvedValue({
      id: GUEST_ID, hotelId: "someone_else",
      igProfileFetchedAt: null, igProfilePicHash: null, igProfilePicKey: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runInstagramProfileJob({ guestId: GUEST_ID, hotelId: HOTEL_ID, igsid: IGSID });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(guestUpdate).not.toHaveBeenCalled();
  });
});

// ── A6: enqueue hook ──────────────────────────────────────────────────────────

describe("maybeEnqueueInstagramProfileJob", () => {
  it("enqueues with a time-bucketed jobId when the guest is stale", async () => {
    guestFindUnique.mockResolvedValue({ igProfileFetchedAt: null });

    await maybeEnqueueInstagramProfileJob({ hotelId: HOTEL_ID, guestId: GUEST_ID, igsid: IGSID });

    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [, data, opts] = queueAdd.mock.calls[0]!;
    expect(data).toEqual({ guestId: GUEST_ID, hotelId: HOTEL_ID, igsid: IGSID });
    expect(opts.jobId).toMatch(/^ig-profile:guest_1:\d+$/);
  });

  it("skips when the guest was enriched within the TTL", async () => {
    guestFindUnique.mockResolvedValue({ igProfileFetchedAt: new Date() });

    await maybeEnqueueInstagramProfileJob({ hotelId: HOTEL_ID, guestId: GUEST_ID, igsid: IGSID });

    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("skips when enrichment is disabled", async () => {
    process.env.INSTAGRAM_PROFILE_ENRICHMENT_ENABLED = "false";

    await maybeEnqueueInstagramProfileJob({ hotelId: HOTEL_ID, guestId: GUEST_ID, igsid: IGSID });

    expect(queueAdd).not.toHaveBeenCalled();
    expect(guestFindUnique).not.toHaveBeenCalled();
  });

  it("never throws — a queue failure must not break the inbound message path", async () => {
    guestFindUnique.mockResolvedValue({ igProfileFetchedAt: null });
    queueAdd.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      maybeEnqueueInstagramProfileJob({ hotelId: HOTEL_ID, guestId: GUEST_ID, igsid: IGSID }),
    ).resolves.toBeUndefined();
  });
});
