"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTextMessage = sendTextMessage;
exports.sendMediaMessage = sendMediaMessage;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const form_data_1 = __importDefault(require("form-data"));
const connect_1 = __importDefault(require("../db/connect"));
const META_API_VERSION = process.env.META_API_VERSION || "v18.0";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";
function metaUrl(p) {
    return `https://graph.facebook.com/${META_API_VERSION}/${p}`;
}
/** Resolve credentials: DB-stored per-hotel > env fallback */
async function resolveCredentials(hotelId) {
    const config = await connect_1.default.hotelConfig.findUnique({ where: { hotelId } });
    const phoneNumberId = config?.metaPhoneNumberId || process.env.META_PHONE_NUMBER_ID || "";
    const accessToken = config?.metaAccessToken || process.env.META_ACCESS_TOKEN || "";
    return { phoneNumberId, accessToken, mockMode: !phoneNumberId || !accessToken };
}
async function metaPost(endpoint, body, accessToken) {
    const res = await fetch(metaUrl(endpoint), {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok)
        throw new Error(`Meta API error: ${JSON.stringify(data)}`);
    return data;
}
async function uploadMediaToMeta(localPath, mimeType, phoneNumberId, accessToken) {
    const form = new form_data_1.default();
    form.append("messaging_product", "whatsapp");
    form.append("file", fs_1.default.createReadStream(localPath), { contentType: mimeType });
    const res = await fetch(metaUrl(`${phoneNumberId}/media`), {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, ...form.getHeaders() },
        body: form,
    });
    const data = (await res.json());
    if (!res.ok || !data.id)
        throw new Error(`Media upload failed: ${JSON.stringify(data)}`);
    return data.id;
}
// ── Text ──────────────────────────────────────────────────────────────────────
async function sendTextMessage(input) {
    const { toPhone, text, hotelId } = input;
    const { phoneNumberId, accessToken, mockMode } = await resolveCredentials(hotelId);
    if (mockMode) {
        console.log("📤 MOCK TEXT SEND:", { toPhone, text });
        return null;
    }
    return metaPost(`${phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        to: toPhone,
        type: "text",
        text: { body: text },
    }, accessToken);
}
// ── Media ─────────────────────────────────────────────────────────────────────
async function sendMediaMessage(input) {
    const { toPhone, hotelId, messageType, mediaUrl, mimeType, fileName, caption } = input;
    const { phoneNumberId, accessToken, mockMode } = await resolveCredentials(hotelId);
    if (mockMode) {
        console.log("📤 MOCK MEDIA SEND:", { toPhone, messageType, mediaUrl });
        return null;
    }
    const localPath = mediaUrl.startsWith("/uploads/")
        ? path_1.default.join(process.cwd(), mediaUrl)
        : null;
    let mediaId = null;
    if (localPath && fs_1.default.existsSync(localPath)) {
        mediaId = await uploadMediaToMeta(localPath, mimeType, phoneNumberId, accessToken);
    }
    if (!mediaId) {
        const publicUrl = `${BACKEND_URL}${mediaUrl}`;
        return metaPost(`${phoneNumberId}/messages`, {
            messaging_product: "whatsapp",
            to: toPhone,
            type: messageType,
            [messageType]: { link: publicUrl, ...(caption ? { caption } : {}), ...(fileName ? { filename: fileName } : {}) },
        }, accessToken);
    }
    return metaPost(`${phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        to: toPhone,
        type: messageType,
        [messageType]: {
            id: mediaId,
            ...(caption ? { caption } : {}),
            ...(fileName ? { filename: fileName } : {}),
        },
    }, accessToken);
}
//# sourceMappingURL=whatsapp.send.service.js.map