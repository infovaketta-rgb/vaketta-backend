"use strict";
/**
 * media.service.ts
 *
 * Downloads incoming WhatsApp media from Meta's API and saves it locally.
 * Provides helpers for building media message payloads to send via Meta API.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadMetaMedia = downloadMetaMedia;
exports.extractMediaFromWebhookMessage = extractMediaFromWebhookMessage;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const META_API_VERSION = process.env.META_API_VERSION || "v18.0";
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN ?? "";
const UPLOADS_DIR = path_1.default.join(process.cwd(), "uploads");
// Ensure uploads directory exists at startup
if (!fs_1.default.existsSync(UPLOADS_DIR))
    fs_1.default.mkdirSync(UPLOADS_DIR, { recursive: true });
/** Map mime types to file extensions */
function mimeToExt(mime) {
    const map = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "video/mp4": "mp4",
        "video/3gpp": "3gp",
        "audio/ogg": "ogg",
        "audio/ogg; codecs=opus": "ogg",
        "audio/mpeg": "mp3",
        "audio/mp4": "m4a",
        "application/pdf": "pdf",
        "application/msword": "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.ms-excel": "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    };
    return map[mime] ?? "bin";
}
/**
 * Fetch a media file from Meta, save it to ./uploads, return local URL.
 * Returns null if credentials are missing or request fails (graceful mock mode).
 */
async function downloadMetaMedia(mediaId, mimeType, originalFileName) {
    if (!ACCESS_TOKEN) {
        console.warn("⚠️  META_ACCESS_TOKEN not set — skipping media download");
        return null;
    }
    try {
        // Step 1: Get download URL from Meta
        const infoRes = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${mediaId}`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
        if (!infoRes.ok)
            throw new Error(`Meta media info failed: ${infoRes.status}`);
        const info = (await infoRes.json());
        if (!info.url)
            throw new Error("No URL in Meta media response");
        // Step 2: Download the actual file
        const fileRes = await fetch(info.url, {
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        });
        if (!fileRes.ok)
            throw new Error(`Meta media download failed: ${fileRes.status}`);
        const buffer = Buffer.from(await fileRes.arrayBuffer());
        const ext = mimeToExt(mimeType);
        const fileName = originalFileName ?? `${(0, crypto_1.randomUUID)()}.${ext}`;
        const filePath = path_1.default.join(UPLOADS_DIR, fileName);
        fs_1.default.writeFileSync(filePath, buffer);
        return {
            localUrl: `/uploads/${fileName}`,
            mimeType,
            fileName,
        };
    }
    catch (err) {
        console.error("❌ Failed to download Meta media:", err);
        return null;
    }
}
/** Extract media payload from a Meta webhook message object */
function extractMediaFromWebhookMessage(message) {
    const type = message?.type;
    if (!type || type === "text" || type === "button" || type === "interactive")
        return null;
    const payload = message?.[type];
    if (!payload?.id)
        return null;
    return {
        mediaId: payload.id,
        mimeType: payload.mime_type ?? "application/octet-stream",
        caption: payload.caption ?? null,
        fileName: payload.filename ?? null,
    };
}
//# sourceMappingURL=media.service.js.map