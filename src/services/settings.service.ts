import prisma from "../db/connect";

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
  const config = await prisma.hotelConfig.findUnique({ where: { hotelId } });
  return {
    metaPhoneNumberId: config?.metaPhoneNumberId ?? null,
    // Mask token — only show last 6 chars so user can see it's set
    metaAccessToken:   config?.metaAccessToken
      ? "••••••••••••••••" + config.metaAccessToken.slice(-6)
      : null,
    metaWabaId:        config?.metaWabaId ?? null,
    connected: !!(config?.metaPhoneNumberId && config?.metaAccessToken),
  };
}

export async function testWhatsAppConnection(hotelId: string): Promise<{ ok: boolean; detail?: string }> {
  const config = await prisma.hotelConfig.findUnique({ where: { hotelId } });
  const phoneNumberId = config?.metaPhoneNumberId || process.env.META_PHONE_NUMBER_ID || "";
  const accessToken   = config?.metaAccessToken   || process.env.META_ACCESS_TOKEN   || "";

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
    metaAccessToken?:   string;
    metaWabaId?:        string;
  }
) {
  // Strip masked placeholder — if token starts with bullets, it hasn't changed
  const patch: Record<string, string> = {};
  if (data.metaPhoneNumberId !== undefined) patch.metaPhoneNumberId = data.metaPhoneNumberId;
  if (data.metaWabaId        !== undefined) patch.metaWabaId        = data.metaWabaId;
  if (data.metaAccessToken !== undefined && !data.metaAccessToken.startsWith("••")) {
    patch.metaAccessToken = data.metaAccessToken;
  }

  return prisma.hotelConfig.upsert({
    where:  { hotelId },
    update: patch,
    create: { hotelId, ...patch },
  });
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
