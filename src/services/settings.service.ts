import prisma from "../db/connect";
import {
  encryptInstagramToken,
  decryptInstagramToken,
  encryptWhatsAppToken,
  decryptWhatsAppToken,
} from "../utils/encryption.utils";

export async function getHotelSettings(hotelId: string) {
  const hotel = await prisma.hotel.findUnique({
    where: { id: hotelId },
    select: {
      id: true,
      name: true,
      phone: true,
      apiKey: true,
      location: true,
      email: true,
      description: true,
      checkInTime: true,
      checkOutTime: true,
      website: true,
      config: true,
      menu: {
        include: {
          items: { orderBy: { order: "asc" } },
        },
      },
      // botMessages lives inside config — returned via config.botMessages
    },
  });

  if (!hotel) throw new Error("Hotel not found");
  return hotel;
}

export async function updateHotelConfig(
  hotelId: string,
  data: {
    autoReplyEnabled?: boolean;
    bookingEnabled?: boolean;
    bookingFlowId?: string | null;
    menuFlowId?: string | null;
    aiEnabled?: boolean;
    businessStartHour?: number;
    businessEndHour?: number;
    timezone?: string;
    defaultLanguage?: string;
    welcomeMessage?: string;
    nightMessage?: string;
    messageDelayEnabled?: boolean;
    messageDelaySeconds?: number;
  }
) {
  const config = await prisma.hotelConfig.upsert({
    where: { hotelId },
    update: data,
    create: { hotelId, ...data },
  });
  return config;
}

export async function updateBotMessages(hotelId: string, botMessages: Record<string, string>) {
  return prisma.hotelConfig.upsert({
    where: { hotelId },
    update: { botMessages },
    create: { hotelId, botMessages },
  });
}

// ── Menu ────────────────────────────────────────────────────────────────────

async function ensureMenu(hotelId: string) {
  const existing = await prisma.hotelMenu.findUnique({ where: { hotelId } });
  if (existing) return existing;
  return prisma.hotelMenu.create({ data: { hotelId } });
}

export async function getMenu(hotelId: string) {
  const menu = await prisma.hotelMenu.findUnique({
    where: { hotelId },
    include: { items: { orderBy: { order: "asc" } } },
  });
  return menu ?? { items: [] };
}

export async function addMenuItem(
  hotelId: string,
  item: { key: string; label: string; replyText: string; type?: string; order: number; flowId?: string | null }
) {
  const menu = await ensureMenu(hotelId);
  return prisma.hotelMenuItem.create({
    data: { menuId: menu.id, ...item },
  });
}

export async function updateMenuItem(
  itemId: string,
  hotelId: string,
  data: Partial<{ key: string; label: string; replyText: string; type: string; order: number; isActive: boolean; flowId: string | null }>
) {
  // Verify item belongs to this hotel's menu
  const item = await prisma.hotelMenuItem.findFirst({
    where: { id: itemId, menu: { hotelId } },
  });
  if (!item) throw new Error("Menu item not found");

  return prisma.hotelMenuItem.update({ where: { id: itemId }, data });
}

export async function deleteMenuItem(itemId: string, hotelId: string) {
  const item = await prisma.hotelMenuItem.findFirst({
    where: { id: itemId, menu: { hotelId } },
  });
  if (!item) throw new Error("Menu item not found");

  return prisma.hotelMenuItem.delete({ where: { id: itemId } });
}

export async function updateMenuTitle(hotelId: string, title: string) {
  const menu = await ensureMenu(hotelId);
  return prisma.hotelMenu.update({ where: { id: menu.id }, data: { title } });
}

// ── WhatsApp / Meta credentials ────────────────────────────────────────────

export async function getWhatsAppConfig(hotelId: string) {
  const [config, platform] = await Promise.all([
    prisma.hotelConfig.findUnique({ where: { hotelId } }),
    prisma.platformSettings.findUnique({ where: { id: "global" } }),
  ]);

  let maskedToken: string | null = null;
  if (config?.metaAccessTokenEncrypted) {
    try {
      const plain = decryptWhatsAppToken(config.metaAccessTokenEncrypted);
      maskedToken = "••••••••••••••••" + plain.slice(-6);
    } catch {
      maskedToken = "••••••••••••••••";
    }
  }

  return {
    metaPhoneNumberId: config?.metaPhoneNumberId ?? null,
    metaAccessToken:   maskedToken,
    metaWabaId:        config?.metaWabaId        ?? null,
    connected: !!(config?.metaPhoneNumberId && config?.metaAccessTokenEncrypted),
    embedUrl: platform?.whatsappEmbedSignupUrl ?? "",
  };
}

export async function testWhatsAppConnection(hotelId: string): Promise<{ ok: boolean; detail?: string }> {
  const config = await prisma.hotelConfig.findUnique({ where: { hotelId } });
  const phoneNumberId = config?.metaPhoneNumberId ?? "";

  let accessToken = "";
  if (config?.metaAccessTokenEncrypted) {
    try { accessToken = decryptWhatsAppToken(config.metaAccessTokenEncrypted); } catch {}
  }

  if (!phoneNumberId || !accessToken) {
    return { ok: false, detail: "Credentials not configured" };
  }

  const version = process.env.META_API_VERSION || "v18.0";
  try {
    const res = await fetch(
      `https://graph.facebook.com/${version}/${phoneNumberId}?fields=id,display_phone_number`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json() as any;
    if (res.ok && data.id) return { ok: true };
    return { ok: false, detail: data?.error?.message ?? "Unexpected response from Meta" };
  } catch (err: any) {
    return { ok: false, detail: err.message };
  }
}

export async function updateWhatsAppConfig(
  hotelId: string,
  data: {
    metaPhoneNumberId?: string;
    metaAccessToken?:   string;   // plain text from frontend
    metaWabaId?:        string;
    metaVerifyToken?:   string;   // accepted for forward compat, not persisted (no schema field)
  }
) {
  const patch: Record<string, unknown> = {};
  if (data.metaPhoneNumberId !== undefined) patch.metaPhoneNumberId = data.metaPhoneNumberId;
  if (data.metaWabaId        !== undefined) patch.metaWabaId        = data.metaWabaId;
  if (data.metaAccessToken !== undefined && !data.metaAccessToken.startsWith("••")) {
    patch.metaAccessTokenEncrypted = encryptWhatsAppToken(data.metaAccessToken);
    patch.metaTokenUpdatedAt       = new Date();
  }

  await prisma.hotelConfig.upsert({
    where:  { hotelId },
    update: patch,
    create: { hotelId, ...patch },
  });

  return getWhatsAppConfig(hotelId);
}

export async function connectWhatsAppEmbeddedSignup(
  hotelId: string,
  code: string,
  wabaId: string,
  phoneNumberId: string,
  redirectUri: string,
  coexistence = false,
): Promise<{ phoneNumberId: string; wabaId: string }> {
  const appId     = process.env.FACEBOOK_APP_ID     ?? "";
  const appSecret = process.env.FACEBOOK_APP_SECRET ?? "";
  if (!appId || !appSecret) throw new Error("Facebook app credentials not configured");

  // 1. Exchange authorisation code for access token
  const tokenRes = await fetch("https://graph.facebook.com/v25.0/oauth/access_token", {
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
  const tokenData = await tokenRes.json() as any;
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(tokenData?.error?.message ?? "Failed to exchange code for access token");
  }
  const accessToken = String(tokenData.access_token);

  // 2. Subscribe the WABA to the app so webhook events are delivered
  const subRes = await fetch(
    `https://graph.facebook.com/v25.0/${wabaId}/subscribed_apps`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const subData = await subRes.json() as any;
  if (!subRes.ok) {
    throw new Error(subData?.error?.message ?? "Failed to subscribe WABA to app");
  }

  // 2b. Also subscribe to Coexistence history fields (best-effort — never throw)
  fetch(
    `https://graph.facebook.com/v25.0/${wabaId}/subscribed_apps` +
    `?subscribed_fields=history,smb_message_echoes`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }
  ).catch(() => { /* best-effort — coexistence fields may not be available on all WABAs */ });

  // 3. Persist encrypted token (hotelId always from JWT, never from request body)
  await prisma.hotelConfig.upsert({
    where:  { hotelId },
    update: {
      metaAccessTokenEncrypted: encryptWhatsAppToken(accessToken),
      metaWabaId:               wabaId,
      metaPhoneNumberId:        phoneNumberId,
      metaTokenUpdatedAt:       new Date(),
    },
    create: {
      hotelId,
      metaAccessTokenEncrypted: encryptWhatsAppToken(accessToken),
      metaWabaId:               wabaId,
      metaPhoneNumberId:        phoneNumberId,
      metaTokenUpdatedAt:       new Date(),
    },
  });

  // If this is a Coexistence flow, request history sync from Meta and mark the hotel
  if (coexistence) {
    // Trigger history sync — best-effort, never throws
    fetch(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/smb_app_data`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body:    JSON.stringify({ messaging_product: "whatsapp", sync_type: "history" }),
      }
    ).catch(() => { /* best-effort */ });

    // Mark sync as pending so the frontend banner shows once webhooks start arriving
    await prisma.hotel.update({
      where: { id: hotelId },
      data:  { historySyncStatus: "pending" },
    });
  }

  return { phoneNumberId, wabaId };
}

export async function updateHotelProfile(
  hotelId: string,
  data: {
    name?: string;
    location?: string;
    email?: string;
    description?: string;
    checkInTime?: string;
    checkOutTime?: string;
    website?: string;
  }
) {
  if (data.name !== undefined && !data.name.trim()) {
    throw new Error("Hotel name cannot be empty");
  }
  return prisma.hotel.update({
    where: { id: hotelId },
    data,
    select: {
      id: true,
      name: true,
      phone: true,
      location: true,
      email: true,
      description: true,
      checkInTime: true,
      checkOutTime: true,
      website: true,
    },
  });
}

// ── Instagram ────────────────────────────────────────────────────────────────

export async function getInstagramConfig(hotelId: string) {
  const [config, platform] = await Promise.all([
    prisma.hotelConfig.findUnique({ where: { hotelId } }),
    prisma.platformSettings.findUnique({ where: { id: "global" } }),
  ]);

  return {
    igAccountId: config?.instagramBusinessAccountId ?? null,
    accessToken: config?.instagramAccessTokenEncrypted ? "••••••••••••••••" : null,
    connected: !!(config?.instagramBusinessAccountId && config?.instagramAccessTokenEncrypted),
    embedUrl: platform?.instagramEmbedUrl ?? "",
  };
}

export async function updateInstagramConfig(
  hotelId: string,
  data: { igAccountId?: string | null; accessToken?: string | null }
) {
  const patch: Record<string, unknown> = {};
  if (data.igAccountId !== undefined) {
    patch.instagramBusinessAccountId = data.igAccountId || null;
  }
  if (data.accessToken !== undefined && !data.accessToken?.startsWith("••")) {
    patch.instagramAccessTokenEncrypted = data.accessToken
      ? encryptInstagramToken(data.accessToken)
      : null;
    patch.instagramTokenUpdatedAt = new Date();
  }

  await prisma.hotelConfig.upsert({
    where:  { hotelId },
    update: patch,
    create: { hotelId, ...patch },
  });

  return getInstagramConfig(hotelId);
}

// ── Instagram webhook subscription ──────────────────────────────────────────

const META_VERSION = "v25.0";

async function getIgCredentials(hotelId: string) {
  const config = await prisma.hotelConfig.findUnique({ where: { hotelId } });
  const accountId = config?.instagramBusinessAccountId;
  const encrypted = config?.instagramAccessTokenEncrypted;
  if (!accountId || !encrypted) throw new Error("Instagram not connected");
  return { accountId, token: decryptInstagramToken(encrypted) };
}

export async function getIgSubscriptionStatus(hotelId: string): Promise<{ subscribed: boolean }> {
  const { accountId, token } = await getIgCredentials(hotelId);
  const res = await fetch(
    `https://graph.facebook.com/${META_VERSION}/${accountId}/subscribed_apps?access_token=${token}`
  );
  const data = await res.json() as any;
  if (!res.ok) throw new Error(data?.error?.message ?? "Failed to check subscription status");
  const subscribed = Array.isArray(data.data) && data.data.length > 0;
  return { subscribed };
}

export async function subscribeIgWebhook(hotelId: string): Promise<{ success: boolean }> {
  const { accountId, token } = await getIgCredentials(hotelId);
  const res = await fetch(
    `https://graph.facebook.com/${META_VERSION}/${accountId}/subscribed_apps`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        subscribed_fields: "messages,messaging_postbacks",
        access_token:      token,
      }),
    }
  );
  const data = await res.json() as any;
  if (!res.ok) throw new Error(data?.error?.message ?? "Failed to subscribe");
  return { success: true };
}

export async function unsubscribeIgWebhook(hotelId: string): Promise<{ success: boolean }> {
  const { accountId, token } = await getIgCredentials(hotelId);
  const res = await fetch(
    `https://graph.facebook.com/${META_VERSION}/${accountId}/subscribed_apps?access_token=${token}`,
    { method: "DELETE" }
  );
  const data = await res.json() as any;
  if (!res.ok) throw new Error(data?.error?.message ?? "Failed to unsubscribe");
  return { success: true };
}

// ── Platform settings (admin-level) ─────────────────────────────────────────

export async function getPlatformSettings() {
  return prisma.platformSettings.upsert({
    where:  { id: "global" },
    update: {},
    create: { id: "global" },
  });
}

export async function updatePlatformSettings(data: { instagramEmbedUrl?: string; whatsappEmbedSignupUrl?: string }) {
  return prisma.platformSettings.upsert({
    where:  { id: "global" },
    update: data,
    create: { id: "global", ...data },
  });
}
