/**
 * instagram.profile.service.ts — Instagram guest profile enrichment.
 *
 * When a guest DMs a hotel's IG professional account, we fetch their public
 * profile from the Graph API (name, username, avatar, follower count, follow
 * relationship), mirror the avatar into R2 (profile_pic URLs are signed
 * *.cdninstagram.com / *.fbcdn.net links that expire in days — never persist
 * or render one), and patch the Guest row.
 *
 * Guest.name is staff-owned (PATCH /conversations/:guestId) and is NEVER
 * written by Graph data — enrichment writes only the ig* columns.
 *
 * IMPORT RULE: nothing here may pull message.service → realtime/emit →
 * server.ts. The queue (→ redis) is imported DYNAMICALLY at enqueue time so
 * unit tests of the pure/fetch helpers never open a Redis connection.
 */
import { createHash } from "crypto";
import prisma from "../db/connect";
import { logger } from "../utils/logger";
import { getMetaVersion, withRetry } from "../utils/metaApi.utils";
import { resolveInstagramCredentials } from "./instagram.send.service";
import { uploadToR2, deleteFromR2, isR2Configured } from "./r2.service";

const log = logger.child({ service: "instagram-profile" });

// ── Config ────────────────────────────────────────────────────────────────────

export function profileTtlMs(): number {
  const hours = Number(process.env.INSTAGRAM_PROFILE_TTL_HOURS) || 24;
  return hours * 60 * 60 * 1000;
}

// On by default — a profile read is not a send, so this is deliberately NOT
// INSTAGRAM_OUTBOUND_ENABLED: receive-only hotels still want avatars.
export function profileEnrichmentEnabled(): boolean {
  return process.env.INSTAGRAM_PROFILE_ENRICHMENT_ENABLED !== "false";
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type IgProfileStatus = "OK" | "NO_CONSENT" | "NOT_FOUND" | "TOKEN_EXPIRED" | "ERROR";

export type IgProfile = {
  name:                 string | null;
  username:             string | null;
  profilePic:           string | null;  // signed CDN URL — mirror it, never store it
  followerCount:        number | null;
  isUserFollowBusiness: boolean | null; // guest follows the hotel
  isBusinessFollowUser: boolean | null; // hotel follows the guest
};

export type InstagramProfileJobData = {
  guestId: string;
  hotelId: string;
  igsid:   string;
  /** Staff-triggered refresh — bypasses the DB TTL re-check in the worker. */
  force?:  boolean;
};

// ── Graph error classification ────────────────────────────────────────────────

/**
 * Classify a Graph API failure into a persistable IgProfileStatus + whether
 * BullMQ should retry. `status` is the HTTP status (null for network errors /
 * aborts), `body` the parsed JSON error body (may be null).
 */
export function classifyGraphError(
  status: number | null,
  body: any,
): { status: IgProfileStatus; retryable: boolean } {
  const err     = body?.error;
  const message = String(err?.message ?? "");
  const code    = typeof err?.code === "number" ? err.code : Number(err?.code);

  // Guest has not granted the app consent to read their profile.
  if (/consent/i.test(message)) return { status: "NO_CONSENT", retryable: false };

  // Dead token — the hotel's IG connection needs a reconnect.
  if (code === 190) return { status: "TOKEN_EXPIRED", retryable: false };

  // Unknown IGSID / unsupported node — also what a blocked guest looks like.
  if (code === 100 || /does not exist/i.test(message) || /Unsupported get request/i.test(message)) {
    return { status: "NOT_FOUND", retryable: false };
  }

  // Rate limiting — app (4), user (17), page/business (32).
  if (status === 429 || code === 4 || code === 17 || code === 32) {
    return { status: "ERROR", retryable: true };
  }

  // Server errors, network failures, timeouts.
  if (status === null || status >= 500) return { status: "ERROR", retryable: true };

  return { status: "ERROR", retryable: false };
}

// ── Profile fetch ─────────────────────────────────────────────────────────────

const MOCK_PROFILE: IgProfile = {
  name:                 "Mock Instagram User",
  username:             "mock.instagram.user",
  profilePic:           null, // no avatar mirroring in mock mode
  followerCount:        1234,
  isUserFollowBusiness: true,
  isBusinessFollowUser: false,
};

const PROFILE_FIELDS =
  "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user";

/**
 * GET https://graph.instagram.com/{version}/{igsid}?fields=…
 *
 * Host MUST be graph.instagram.com — the stored credential is a long-lived IG
 * User token (IGAA…) from Business Login; graph.facebook.com rejects it with
 * OAuthException 190 "Cannot parse access token" (see the metaPost comment in
 * instagram.send.service.ts).
 *
 * Throws an Error carrying { status, graphBody } for classifyGraphError.
 * Never logs the token or the full response body.
 */
export async function fetchInstagramUserProfile(input: {
  igsid:       string;
  accessToken: string;
  version:     string;
}): Promise<IgProfile> {
  const { igsid, accessToken, version } = input;

  if (process.env.MOCK_INSTAGRAM_PROFILE === "true") {
    log.info({ igsid }, "MOCK INSTAGRAM profile fetch");
    return { ...MOCK_PROFILE };
  }

  // Token goes in the Authorization header, not the query string (query
  // strings end up in logs).
  const res = await fetch(
    `https://graph.instagram.com/${version}/${igsid}?fields=${PROFILE_FIELDS}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal:  AbortSignal.timeout(15000),
    },
  );

  const data = await res.json().catch(() => null) as any;

  if (!res.ok) {
    // Keep only the classification-relevant subset of the error body — never
    // the full response — so downstream logging can't leak anything sensitive.
    const graphErr = data?.error
      ? {
          message:       String(data.error.message ?? ""),
          code:          data.error.code,
          error_subcode: data.error.error_subcode,
          type:          data.error.type,
        }
      : null;
    const err: any = new Error(`Instagram profile fetch failed: HTTP ${res.status}`);
    err.status    = res.status;
    err.graphBody = graphErr ? { error: graphErr } : null;
    throw err;
  }

  return {
    name:                 data?.name          != null ? String(data.name)     : null,
    username:             data?.username      != null ? String(data.username) : null,
    profilePic:           data?.profile_pic   != null ? String(data.profile_pic) : null,
    followerCount:        data?.follower_count != null ? Number(data.follower_count) : null,
    isUserFollowBusiness: typeof data?.is_user_follow_business === "boolean" ? data.is_user_follow_business : null,
    isBusinessFollowUser: typeof data?.is_business_follow_user === "boolean" ? data.is_business_follow_user : null,
  };
}

// ── Avatar mirroring ──────────────────────────────────────────────────────────

// Avatars are small JPEGs — r2.service's 16 MB image cap is far too permissive.
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
// Image subset of r2.service's MIME allowlist.
const AVATAR_ALLOWED_MIMES = ["image/jpeg", "image/png", "image/webp"];

export type MirroredAvatar = { url: string; key: string; hash: string };

/**
 * Download the signed CDN avatar and mirror it to R2. Returns the new
 * { url, key, hash }, or null when the pic fields should be left as-is
 * (no pic, bytes unchanged vs stored hash, or R2 unavailable).
 *
 * The sha256 short-circuit is what stops a daily refresh from creating an
 * orphan R2 object every time the signed URL rotates.
 */
export async function mirrorInstagramAvatar(input: {
  hotelId:    string;
  picUrl:     string | null;
  prevHash:   string | null;
  prevKey:    string | null;
}): Promise<MirroredAvatar | null> {
  const { hotelId, picUrl, prevHash, prevKey } = input;
  if (!picUrl) return null;

  if (!isR2Configured()) {
    // uploadToR2 throws without credentials (the env.ts "falls back to local
    // disk" warning is about staff media uploads, not this path) — skip
    // mirroring rather than fail every enrichment in local dev.
    log.warn({ hotelId }, "R2 not configured — skipping avatar mirror");
    return null;
  }

  const res = await fetch(picUrl, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`avatar download failed: HTTP ${res.status}`);

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!AVATAR_ALLOWED_MIMES.includes(contentType)) {
    throw new Error(`avatar has unexpected content-type: ${contentType || "(none)"}`);
  }

  const declaredLength = Number(res.headers.get("content-length"));
  if (declaredLength && declaredLength > AVATAR_MAX_BYTES) {
    throw new Error(`avatar too large: ${declaredLength} bytes`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > AVATAR_MAX_BYTES) {
    throw new Error(`avatar too large: ${buffer.byteLength} bytes`);
  }

  const hash = createHash("sha256").update(buffer).digest("hex");
  if (prevHash && hash === prevHash) return null; // unchanged — keep existing URL, no upload

  const uploaded = await uploadToR2(buffer, contentType, { hotelId });

  // Best-effort delete of the superseded object (deleteFromR2 never throws).
  if (prevKey) {
    await deleteFromR2(prevKey).catch((err) =>
      log.warn({ err, prevKey }, "failed to delete previous avatar object"));
  }

  return { url: uploaded.url, key: uploaded.key, hash };
}

// ── Worker job body ───────────────────────────────────────────────────────────

async function recordProfileStatus(guestId: string, status: IgProfileStatus): Promise<void> {
  // Always stamp igProfileFetchedAt, including on permanent failures — that's
  // what stops us hammering Graph once per message for a guest who will never
  // resolve (the TTL check treats a recorded failure as fresh).
  await prisma.guest.update({
    where: { id: guestId },
    data:  { igProfileStatus: status, igProfileFetchedAt: new Date() },
  });
}

/**
 * Full enrichment run — called by instagramProfile.worker. Throws ONLY for
 * retryable failures; permanent ones are recorded on the Guest row and the
 * job completes (otherwise BullMQ burns all 3 attempts on a permanent
 * condition).
 */
export async function runInstagramProfileJob(data: InstagramProfileJobData): Promise<void> {
  const { guestId, hotelId, igsid, force } = data;

  // Re-read the guest and re-check the TTL in the DB — the job may have been
  // queued before a concurrent run refreshed it.
  const guest = await prisma.guest.findUnique({
    where:  { id: guestId },
    select: {
      id: true, hotelId: true,
      igProfileFetchedAt: true, igProfilePicHash: true, igProfilePicKey: true,
    },
  });
  if (!guest || guest.hotelId !== hotelId) return;
  if (
    !force &&
    guest.igProfileFetchedAt &&
    Date.now() - guest.igProfileFetchedAt.getTime() < profileTtlMs()
  ) {
    return; // fresh — a concurrent run already refreshed it
  }

  const mockMode = process.env.MOCK_INSTAGRAM_PROFILE === "true";

  let accessToken = "";
  if (!mockMode) {
    try {
      ({ accessToken } = await resolveInstagramCredentials(hotelId));
    } catch {
      // No stored IG credentials — permanent until the hotel reconnects.
      log.warn({ hotelId, guestId }, "instagram profile: credentials missing — recording ERROR");
      await recordProfileStatus(guestId, "ERROR");
      return;
    }
  }

  let profile: IgProfile;
  try {
    const version = await getMetaVersion();
    profile = await withRetry(() => fetchInstagramUserProfile({ igsid, accessToken, version }));
  } catch (err: any) {
    const classified = classifyGraphError(err?.status ?? null, err?.graphBody ?? null);
    if (classified.retryable) throw err; // BullMQ retries per the queue backoff policy

    if (classified.status === "TOKEN_EXPIRED") {
      log.error({ hotelId, guestId }, "instagram profile: token expired — hotel's IG connection is dead");
    } else {
      log.warn({ hotelId, guestId, profileStatus: classified.status }, "instagram profile fetch failed permanently");
    }
    await recordProfileStatus(guestId, classified.status);
    return;
  }

  // Avatar mirroring must never fail the whole job — on failure keep the text
  // fields and leave the pic fields as-is.
  let avatar: MirroredAvatar | null = null;
  try {
    avatar = await mirrorInstagramAvatar({
      hotelId,
      picUrl:   profile.profilePic,
      prevHash: guest.igProfilePicHash,
      prevKey:  guest.igProfilePicKey,
    });
  } catch (err) {
    log.warn({ err, hotelId, guestId }, "instagram avatar mirror failed — keeping text fields");
  }

  // Patch by exact id, never by phone. Guest.name untouched — staff-owned.
  await prisma.guest.update({
    where: { id: guestId },
    data: {
      igName:             profile.name,
      igUsername:         profile.username,
      igFollowerCount:    profile.followerCount,
      igFollowsBusiness:  profile.isUserFollowBusiness,
      igBusinessFollows:  profile.isBusinessFollowUser,
      igProfileFetchedAt: new Date(),
      igProfileStatus:    "OK",
      ...(avatar
        ? { igProfilePicUrl: avatar.url, igProfilePicKey: avatar.key, igProfilePicHash: avatar.hash }
        : {}),
    },
  });
}

// ── Enqueue hooks ─────────────────────────────────────────────────────────────

/**
 * Inbound-message hook (normal inbound only — consent comes from the guest
 * messaging us; echoes are our own outbound). Never throws: enrichment must
 * never break the inbound message path.
 */
export async function maybeEnqueueInstagramProfileJob(input: {
  hotelId: string;
  guestId: string;
  igsid:   string;
}): Promise<void> {
  const { hotelId, guestId, igsid } = input;
  try {
    if (!profileEnrichmentEnabled()) return;

    const guest = await prisma.guest.findUnique({
      where:  { id: guestId },
      select: { igProfileFetchedAt: true },
    });
    if (!guest) return;

    const ttlMs = profileTtlMs();
    if (guest.igProfileFetchedAt && Date.now() - guest.igProfileFetchedAt.getTime() < ttlMs) return;

    // Time-bucketed jobId collapses a burst of messages into one job. The DB
    // TTL check in the worker is still the real guard — removeOnComplete
    // { count: 100 } evicts this dedup key quickly.
    const { instagramProfileQueue } = await import("../queue/instagramProfile.queue");
    await instagramProfileQueue.add(
      "enrich-profile",
      { guestId, hotelId, igsid } satisfies InstagramProfileJobData,
      { jobId: `ig-profile:${guestId}:${Math.floor(Date.now() / ttlMs)}` },
    );
  } catch (err) {
    log.warn({ err, hotelId, guestId }, "instagram profile enqueue failed — inbound path unaffected");
  }
}

/** Staff-triggered refresh — bypasses the TTL. Throws on queue failure. */
export async function enqueueInstagramProfileRefresh(input: {
  hotelId: string;
  guestId: string;
  igsid:   string;
}): Promise<void> {
  const { hotelId, guestId, igsid } = input;
  const { instagramProfileQueue } = await import("../queue/instagramProfile.queue");
  await instagramProfileQueue.add(
    "enrich-profile",
    { guestId, hotelId, igsid, force: true } satisfies InstagramProfileJobData,
    { jobId: `ig-profile:refresh:${guestId}:${Date.now()}` },
  );
}
