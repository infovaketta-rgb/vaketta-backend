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
 * NOTE: the "Facebook Login for Business / IG_API_ONBOARDING" flow does NOT use a
 * server-side code→token exchange. Meta's manual redirect dialog (response_type=token,
 * extras {"setup":{"channel":"IG_API_ONBOARDING"}}) returns the access token directly
 * in the redirect URL fragment, which the client POSTs to /api/instagram/connect-with
 * -token. The former exchangeInstagramCodeForToken() has been removed accordingly.
 *
 * exchangeForLongLivedToken remains as a utility (the redirect already appends a
 * long-lived token, so the route does not call this — kept for completeness).
 */
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
  const fields = "id,name,access_token,instagram_business_account{id,name}";
  const url = new URL(`https://graph.facebook.com/${META_VERSION}/me/accounts`);
  url.searchParams.set("fields",       fields);
  url.searchParams.set("access_token", userToken);

  // TEMP DIAGNOSTIC (remove after debugging "No Instagram Business accounts found").
  // Prints the exact fields requested + the raw /me/accounts response with the
  // access_token values REDACTED, so we can see whether the page appears at all and
  // whether instagram_business_account is present, null, or absent on it.
  console.log("[ig-diag] /me/accounts fields requested:", fields);

  const res  = await fetch(url.toString());
  const data = await res.json() as any;
  if (!res.ok) {
    console.log("[ig-diag] /me/accounts FAILED:", JSON.stringify(redactPagesPayload(data)));
    throw new Error(data?.error?.message ?? "Failed to fetch Facebook pages");
  }

  // Raw response, token-redacted, plus a per-page summary of the IG linkage.
  console.log("[ig-diag] /me/accounts raw (tokens redacted):", JSON.stringify(redactPagesPayload(data)));
  const summary = ((data.data ?? []) as any[]).map((p) => ({
    id:   p.id,
    name: p.name,
    instagram_business_account:
      p.instagram_business_account === undefined ? "ABSENT"
      : p.instagram_business_account === null     ? "NULL"
      : `PRESENT(${p.instagram_business_account.id})`,
  }));
  console.log("[ig-diag] /me/accounts pages:", data.data?.length ?? 0, "| IG linkage:", JSON.stringify(summary));

  // Permissions check: confirm pages_show_list + instagram_basic are GRANTED on this
  // exact token (not just requested). Best-effort — never blocks the connect flow.
  await logTokenPermissions(userToken, META_VERSION);

  const matched = ((data.data ?? []) as any[])
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

  // FALLBACK: if /me/accounts returned pages but none carried an embedded
  // instagram_business_account, query each page directly — Meta frequently omits the
  // field from the aggregate /me/accounts response even when the linkage exists
  // (the docs describe /{page-id}?fields=instagram_business_account as the canonical
  // per-page lookup). This is the documented two-step path.
  if (matched.length === 0 && (data.data?.length ?? 0) > 0) {
    console.log("[ig-diag] no embedded IG on any page — trying per-page lookup");
    const recovered: FacebookPage[] = [];
    for (const p of data.data as any[]) {
      try {
        const igAccount = await fetchPageInstagram(String(p.id), String(p.access_token), META_VERSION);
        if (igAccount) {
          recovered.push({ id: String(p.id), name: String(p.name), accessToken: String(p.access_token), igAccount });
        }
      } catch (err: any) {
        console.log("[ig-diag] per-page lookup failed for", p.id, "—", err?.message);
      }
    }
    console.log("[ig-diag] per-page lookup recovered", recovered.length, "page(s) with IG");
    return recovered;
  }

  return matched;
}

/** Per-page IG lookup: GET /{page-id}?fields=instagram_business_account{id,name}. */
async function fetchPageInstagram(
  pageId: string,
  pageAccessToken: string,
  metaVersion: string,
): Promise<{ id: string; name: string } | null> {
  const url = new URL(`https://graph.facebook.com/${metaVersion}/${pageId}`);
  url.searchParams.set("fields",       "instagram_business_account{id,name}");
  url.searchParams.set("access_token", pageAccessToken);
  const res  = await fetch(url.toString());
  const data = await res.json() as any;
  const iba  = data?.instagram_business_account;
  console.log("[ig-diag] /{page}/instagram_business_account for", pageId, ":",
    iba === undefined ? "ABSENT" : iba === null ? "NULL" : `PRESENT(${iba.id})`);
  if (!res.ok || !iba?.id) return null;
  return { id: String(iba.id), name: String(iba.name ?? "") };
}

/** Redact access_token values from a /me/accounts payload before logging. */
function redactPagesPayload(payload: any): any {
  if (!payload || typeof payload !== "object") return payload;
  const clone = JSON.parse(JSON.stringify(payload));
  if (Array.isArray(clone.data)) {
    for (const p of clone.data) {
      if (p && typeof p.access_token === "string") {
        p.access_token = `«redacted len=${p.access_token.length}»`;
      }
    }
  }
  return clone;
}

/** Best-effort: log which permissions are actually granted on the token. */
async function logTokenPermissions(userToken: string, metaVersion: string): Promise<void> {
  try {
    const url = new URL(`https://graph.facebook.com/${metaVersion}/me/permissions`);
    url.searchParams.set("access_token", userToken);
    const res  = await fetch(url.toString());
    const data = await res.json() as any;
    const perms = ((data?.data ?? []) as any[])
      .map((d) => `${d.permission}:${d.status}`)
      .join(", ");
    console.log("[ig-diag] /me/permissions:", perms || "(none returned)");
  } catch (err: any) {
    console.log("[ig-diag] /me/permissions check failed:", err?.message);
  }
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
