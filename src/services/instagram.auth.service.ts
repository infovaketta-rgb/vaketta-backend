import prisma from "../db/connect";
import { encryptInstagramToken } from "./instagram.service";

const VERSION_TTL_MS = 300_000;
let _cachedVersion: { value: string; expiresAt: number } | null = null;

async function getMetaVersion(): Promise<string> {
  const now = Date.now();
  if (_cachedVersion && now < _cachedVersion.expiresAt) return _cachedVersion.value;
  try {
    const row = await prisma.platformSettings.findUnique({ where: { id: "global" } }) as
      { metaApiVersion?: string | null } | null;
    const v = row?.metaApiVersion ?? "v25.0";
    _cachedVersion = { value: v, expiresAt: now + VERSION_TTL_MS };
    return v;
  } catch {
    return _cachedVersion?.value ?? "v25.0";
  }
}

export interface FacebookPage {
  id: string;
  name: string;
  accessToken: string;
  igAccount: { id: string; name: string } | null;
}

/**
 * Exchange a Facebook-Login-for-Business authorisation `code` (returned by the
 * config_id-based FB.login() popup) for a user access token. Mirrors WhatsApp's
 * embedded-signup exchange (`connectWhatsAppEmbeddedSignup`, settings.service.ts):
 * same `grant_type: "authorization_code"` POST to `/oauth/access_token`.
 *
 * Returns the user access token; the caller continues into the existing
 * /me/accounts → instagram_business_account lookup unchanged.
 */
export async function exchangeInstagramCodeForToken(
  code: string,
  redirectUri: string,
): Promise<string> {
  const appId     = process.env.FACEBOOK_APP_ID     ?? "";
  const appSecret = process.env.FACEBOOK_APP_SECRET ?? "";
  if (!appId || !appSecret) throw new Error("Facebook app credentials not configured");

  const META_VERSION = await getMetaVersion();
  const res = await fetch(`https://graph.facebook.com/${META_VERSION}/oauth/access_token`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      client_id:     appId,
      client_secret: appSecret,
      grant_type:    "authorization_code",
      redirect_uri:  redirectUri,
      code,
    }),
  });
  const data = await res.json() as any;
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error?.message ?? "Failed to exchange code for access token");
  }
  return String(data.access_token);
}

export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<string> {
  const appId     = process.env.FACEBOOK_APP_ID     ?? "";
  const appSecret = process.env.FACEBOOK_APP_SECRET ?? "";
  if (!appId || !appSecret) throw new Error("Facebook app credentials not configured");

  const META_VERSION = await getMetaVersion();
  const url = new URL(`https://graph.facebook.com/${META_VERSION}/oauth/access_token`);
  url.searchParams.set("grant_type",       "fb_exchange_token");
  url.searchParams.set("client_id",        appId);
  url.searchParams.set("client_secret",    appSecret);
  url.searchParams.set("fb_exchange_token", shortLivedToken);

  const res  = await fetch(url.toString());
  const data = await res.json() as any;
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error?.message ?? "Failed to exchange for long-lived token");
  }
  return String(data.access_token);
}

export async function getPagesWithInstagram(userToken: string): Promise<FacebookPage[]> {
  const META_VERSION = await getMetaVersion();
  const url = new URL(`https://graph.facebook.com/${META_VERSION}/me/accounts`);
  url.searchParams.set("fields",       "id,name,access_token,instagram_business_account{id,name}");
  url.searchParams.set("access_token", userToken);

  const res  = await fetch(url.toString());
  const data = await res.json() as any;
  if (!res.ok) {
    throw new Error(data?.error?.message ?? "Failed to fetch Facebook pages");
  }

  return ((data.data ?? []) as any[])
    .filter((p) => p.instagram_business_account)
    .map((p) => ({
      id:          String(p.id),
      name:        String(p.name),
      accessToken: String(p.access_token),
      igAccount:   p.instagram_business_account
        ? {
            id:   String(p.instagram_business_account.id),
            name: String(p.instagram_business_account.name ?? ""),
          }
        : null,
    }));
}

export async function connectInstagramViaPage(
  hotelId: string,
  pageId: string,
  pageAccessToken: string
): Promise<{ instagramBusinessAccountId: string }> {
  const META_VERSION = await getMetaVersion();
  const url = new URL(`https://graph.facebook.com/${META_VERSION}/${pageId}`);
  url.searchParams.set("fields",       "instagram_business_account");
  url.searchParams.set("access_token", pageAccessToken);

  const res  = await fetch(url.toString());
  const data = await res.json() as any;
  if (!res.ok || !data.instagram_business_account?.id) {
    throw new Error(
      data?.error?.message ?? "No Instagram Business Account linked to this Facebook page"
    );
  }

  const igAccountId = String(data.instagram_business_account.id);
  const now         = new Date();

  await prisma.hotelConfig.upsert({
    where:  { hotelId },
    update: {
      instagramAccessTokenEncrypted: encryptInstagramToken(pageAccessToken),
      instagramBusinessAccountId:    igAccountId,
      facebookPageId:                pageId,
      instagramConnectedAt:          now,
      instagramTokenUpdatedAt:       now,
    },
    create: {
      hotelId,
      instagramAccessTokenEncrypted: encryptInstagramToken(pageAccessToken),
      instagramBusinessAccountId:    igAccountId,
      facebookPageId:                pageId,
      instagramConnectedAt:          now,
      instagramTokenUpdatedAt:       now,
    },
  });

  return { instagramBusinessAccountId: igAccountId };
}

export async function subscribePageToWebhook(
  hotelId: string,
  pageId: string,
  pageAccessToken: string
): Promise<void> {
  const META_VERSION = await getMetaVersion();
  const res = await fetch(
    `https://graph.facebook.com/${META_VERSION}/${pageId}/subscribed_apps`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        subscribed_fields: "messages,messaging_postbacks",
        access_token:      pageAccessToken,
      }),
    }
  );
  const data = await res.json() as any;
  if (!res.ok) {
    throw new Error(data?.error?.message ?? "Failed to subscribe page to webhook");
  }

  await prisma.hotelConfig.update({
    where: { hotelId },
    data:  { instagramWebhookActive: true },
  });
}
