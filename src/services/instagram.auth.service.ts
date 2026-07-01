import prisma from "../db/connect";
import { encryptInstagramToken } from "./instagram.service";

const INSTAGRAM_TOKEN_URL   = "https://api.instagram.com/oauth/access_token";
const INSTAGRAM_GRAPH_BASE  = "https://graph.instagram.com";

/**
 * Exchange an Instagram authorisation code for a short-lived user access token.
 * Uses the Instagram Graph API (api.instagram.com), not graph.facebook.com.
 *
 * Ref: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/
 */
export async function exchangeInstagramCode(
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; userId: string }> {
  const appId     = process.env.INSTAGRAM_APP_ID     ?? "";
  const appSecret = process.env.INSTAGRAM_APP_SECRET ?? "";
  if (!appId || !appSecret) {
    throw new Error("Instagram app credentials not configured");
  }

  const body = new URLSearchParams({
    client_id:     appId,
    client_secret: appSecret,
    grant_type:    "authorization_code",
    redirect_uri:  redirectUri,
    code,
  });

  const res  = await fetch(INSTAGRAM_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  const raw = await res.json() as any;

  // Response is {"data":[{"access_token":…,"user_id":…,"permissions":[…]}]}
  const entry = Array.isArray(raw?.data) ? raw.data[0] : raw;

  if (!res.ok || !entry?.access_token) {
    throw new Error(raw?.error_message ?? raw?.error?.message ?? "Failed to exchange Instagram code for token");
  }

  return {
    accessToken: String(entry.access_token),
    userId:      String(entry.user_id),
  };
}

/**
 * Exchange a short-lived Instagram token for a long-lived one (60-day TTL).
 * GET https://graph.instagram.com/access_token
 */
export async function getLongLivedToken(shortLivedToken: string): Promise<string> {
  const appSecret = process.env.INSTAGRAM_APP_SECRET ?? "";
  if (!appSecret) throw new Error("INSTAGRAM_APP_SECRET not configured");

  const url = new URL(`${INSTAGRAM_GRAPH_BASE}/access_token`);
  url.searchParams.set("grant_type",    "ig_exchange_token");
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("access_token",  shortLivedToken);

  const res  = await fetch(url.toString());
  const data = await res.json() as any;

  if (!res.ok || !data.access_token) {
    throw new Error(data?.error?.message ?? "Failed to exchange for long-lived Instagram token");
  }

  return String(data.access_token);
}

/**
 * Fetch the Instagram account's user_id and username from the Graph API.
 * GET https://graph.instagram.com/me?fields=user_id,username
 * Note: fields are Instagram Login API fields — `id`/`name` are Facebook Login fields
 * and are not available here.
 */
export async function getInstagramAccountInfo(
  longLivedToken: string,
): Promise<{ id: string; username: string }> {
  const url = new URL(`${INSTAGRAM_GRAPH_BASE}/me`);
  url.searchParams.set("fields",       "user_id,username");
  url.searchParams.set("access_token", longLivedToken);

  const res  = await fetch(url.toString());
  const data = await res.json() as any;

  if (!res.ok || !data.user_id) {
    throw new Error(data?.error?.message ?? "Failed to fetch Instagram account info");
  }

  return {
    id:       String(data.user_id),
    username: String(data.username ?? ""),
  };
}

/**
 * Subscribe the Instagram user account to webhook messages.
 * POST https://graph.instagram.com/v25.0/{ig-user-id}/subscribed_apps
 *   ?subscribed_fields=messages&access_token={instagram_user_token}
 *
 * This is a per-account call required for Business Login for Instagram.
 * The node is the Instagram-scoped user ID (not a Facebook Page ID).
 */
export async function subscribeInstagramWebhook(
  igUserId: string,
  accessToken: string,
): Promise<void> {
  const url = new URL(`${INSTAGRAM_GRAPH_BASE}/v25.0/${igUserId}/subscribed_apps`);
  url.searchParams.set("subscribed_fields", "messages");
  url.searchParams.set("access_token",      accessToken);

  const res  = await fetch(url.toString(), { method: "POST" });
  const data = await res.json() as any;

  if (!res.ok) {
    throw new Error(data?.error?.message ?? "Failed to subscribe Instagram account to webhook");
  }
}

/**
 * Full connect flow: code → short token → webhook subscription → long token → account info → DB write.
 * No Facebook Page lookup needed — Business Login for Instagram grants direct access.
 */
export async function connectInstagram(
  hotelId: string,
  code: string,
  redirectUri: string,
): Promise<{ instagramBusinessAccountId: string; username: string }> {
  const { accessToken: shortToken, userId } = await exchangeInstagramCode(code, redirectUri);

  // Subscribe BEFORE exchanging for a long-lived token — use the short-lived token,
  // which is valid for the subscription call. The subscription persists beyond token refresh.
  await subscribeInstagramWebhook(userId, shortToken);

  const longToken = await getLongLivedToken(shortToken);
  const account   = await getInstagramAccountInfo(longToken);

  // 60-day long-lived token expiry — set conservatively at 59 days for safety
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + 59 * 24 * 60 * 60 * 1000);

  await prisma.hotelConfig.upsert({
    where:  { hotelId },
    update: {
      instagramAccessTokenEncrypted: encryptInstagramToken(longToken),
      instagramBusinessAccountId:    account.id,
      instagramConnectedAt:          now,
      instagramTokenUpdatedAt:       now,
      instagramTokenExpiresAt:       expiresAt,
      instagramWebhookActive:        true,
    },
    create: {
      hotelId,
      instagramAccessTokenEncrypted: encryptInstagramToken(longToken),
      instagramBusinessAccountId:    account.id,
      instagramConnectedAt:          now,
      instagramTokenUpdatedAt:       now,
      instagramTokenExpiresAt:       expiresAt,
      instagramWebhookActive:        true,
    },
  });

  return { instagramBusinessAccountId: account.id, username: account.username };
}
