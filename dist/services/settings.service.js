"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHotelSettings = getHotelSettings;
exports.updateHotelConfig = updateHotelConfig;
exports.updateBotMessages = updateBotMessages;
exports.getMenu = getMenu;
exports.addMenuItem = addMenuItem;
exports.updateMenuItem = updateMenuItem;
exports.deleteMenuItem = deleteMenuItem;
exports.updateMenuTitle = updateMenuTitle;
exports.getWhatsAppConfig = getWhatsAppConfig;
exports.testWhatsAppConnection = testWhatsAppConnection;
exports.updateWhatsAppConfig = updateWhatsAppConfig;
exports.updateHotelProfile = updateHotelProfile;
const connect_1 = __importDefault(require("../db/connect"));
async function getHotelSettings(hotelId) {
    const hotel = await connect_1.default.hotel.findUnique({
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
    if (!hotel)
        throw new Error("Hotel not found");
    return hotel;
}
async function updateHotelConfig(hotelId, data) {
    const config = await connect_1.default.hotelConfig.upsert({
        where: { hotelId },
        update: data,
        create: { hotelId, ...data },
    });
    return config;
}
async function updateBotMessages(hotelId, botMessages) {
    return connect_1.default.hotelConfig.upsert({
        where: { hotelId },
        update: { botMessages },
        create: { hotelId, botMessages },
    });
}
// ── Menu ────────────────────────────────────────────────────────────────────
async function ensureMenu(hotelId) {
    const existing = await connect_1.default.hotelMenu.findUnique({ where: { hotelId } });
    if (existing)
        return existing;
    return connect_1.default.hotelMenu.create({ data: { hotelId } });
}
async function getMenu(hotelId) {
    const menu = await connect_1.default.hotelMenu.findUnique({
        where: { hotelId },
        include: { items: { orderBy: { order: "asc" } } },
    });
    return menu ?? { items: [] };
}
async function addMenuItem(hotelId, item) {
    const menu = await ensureMenu(hotelId);
    return connect_1.default.hotelMenuItem.create({
        data: { menuId: menu.id, ...item },
    });
}
async function updateMenuItem(itemId, hotelId, data) {
    // Verify item belongs to this hotel's menu
    const item = await connect_1.default.hotelMenuItem.findFirst({
        where: { id: itemId, menu: { hotelId } },
    });
    if (!item)
        throw new Error("Menu item not found");
    return connect_1.default.hotelMenuItem.update({ where: { id: itemId }, data });
}
async function deleteMenuItem(itemId, hotelId) {
    const item = await connect_1.default.hotelMenuItem.findFirst({
        where: { id: itemId, menu: { hotelId } },
    });
    if (!item)
        throw new Error("Menu item not found");
    return connect_1.default.hotelMenuItem.delete({ where: { id: itemId } });
}
async function updateMenuTitle(hotelId, title) {
    const menu = await ensureMenu(hotelId);
    return connect_1.default.hotelMenu.update({ where: { id: menu.id }, data: { title } });
}
// ── WhatsApp / Meta credentials ────────────────────────────────────────────
async function getWhatsAppConfig(hotelId) {
    const config = await connect_1.default.hotelConfig.findUnique({ where: { hotelId } });
    return {
        metaPhoneNumberId: config?.metaPhoneNumberId ?? null,
        // Mask token — only show last 6 chars so user can see it's set
        metaAccessToken: config?.metaAccessToken
            ? "••••••••••••••••" + config.metaAccessToken.slice(-6)
            : null,
        metaWabaId: config?.metaWabaId ?? null,
        metaVerifyToken: config?.metaVerifyToken ?? null,
        connected: !!(config?.metaPhoneNumberId && config?.metaAccessToken),
    };
}
async function testWhatsAppConnection(hotelId) {
    const config = await connect_1.default.hotelConfig.findUnique({ where: { hotelId } });
    const phoneNumberId = config?.metaPhoneNumberId || process.env.META_PHONE_NUMBER_ID || "";
    const accessToken = config?.metaAccessToken || process.env.META_ACCESS_TOKEN || "";
    if (!phoneNumberId || !accessToken) {
        return { ok: false, detail: "Credentials not configured" };
    }
    const version = process.env.META_API_VERSION || "v18.0";
    try {
        const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}?fields=id,display_phone_number`, { headers: { Authorization: `Bearer ${accessToken}` } });
        const data = await res.json();
        if (res.ok && data.id)
            return { ok: true };
        return { ok: false, detail: data?.error?.message ?? "Unexpected response from Meta" };
    }
    catch (err) {
        return { ok: false, detail: err.message };
    }
}
async function updateWhatsAppConfig(hotelId, data) {
    // Strip masked placeholder — if token starts with bullets, it hasn't changed
    const patch = {};
    if (data.metaPhoneNumberId !== undefined)
        patch.metaPhoneNumberId = data.metaPhoneNumberId;
    if (data.metaWabaId !== undefined)
        patch.metaWabaId = data.metaWabaId;
    if (data.metaVerifyToken !== undefined)
        patch.metaVerifyToken = data.metaVerifyToken;
    if (data.metaAccessToken !== undefined && !data.metaAccessToken.startsWith("••")) {
        patch.metaAccessToken = data.metaAccessToken;
    }
    return connect_1.default.hotelConfig.upsert({
        where: { hotelId },
        update: patch,
        create: { hotelId, ...patch },
    });
}
async function updateHotelProfile(hotelId, data) {
    if (data.name !== undefined && !data.name.trim()) {
        throw new Error("Hotel name cannot be empty");
    }
    return connect_1.default.hotel.update({
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
//# sourceMappingURL=settings.service.js.map