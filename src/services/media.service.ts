/**
 * media.service.ts
 *
 * Downloads incoming WhatsApp media from Meta's API and saves it locally.
 * Provides helpers for building media message payloads to send via Meta API.
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const META_API_VERSION = process.env.META_API_VERSION || "v18.0";
const ACCESS_TOKEN     = process.env.META_ACCESS_TOKEN ?? "";
const UPLOADS_DIR      = path.join(process.cwd(), "uploads");

// Ensure uploads directory exists at startup
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/** Map mime types to file extensions */
function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg":           "jpg",
    "image/jpg":            "jpg",
    "image/png":            "png",
    "image/webp":           "webp",
    "image/gif":            "gif",
    "video/mp4":            "mp4",
    "video/3gpp":           "3gp",
    "audio/ogg":            "ogg",
    "audio/ogg; codecs=opus": "ogg",
    "audio/mpeg":           "mp3",
    "audio/mp4":            "m4a",
    "application/pdf":      "pdf",
    "application/msword":   "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };
  return map[mime] ?? "bin";
}

export type DownloadedMedia = {
  localUrl:  string;   // e.g. "/uploads/abc123.jpg"
  mimeType:  string;
  fileName:  string;
};

/**
 * Fetch a media file from Meta, save it to ./uploads, return local URL.
 * Returns null if credentials are missing or request fails (graceful mock mode).
 */
export async function downloadMetaMedia(
  mediaId:  string,
  mimeType: string,
  originalFileName?: string
): Promise<DownloadedMedia | null> {
  if (!ACCESS_TOKEN) {
    console.warn("⚠️  META_ACCESS_TOKEN not set — skipping media download");
    return null;
  }

  try {
    // Step 1: Get download URL from Meta
    const infoRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    if (!infoRes.ok) throw new Error(`Meta media info failed: ${infoRes.status}`);
    const info = (await infoRes.json()) as { url?: string };
    if (!info.url) throw new Error("No URL in Meta media response");

    // Step 2: Download the actual file
    const fileRes = await fetch(info.url, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (!fileRes.ok) throw new Error(`Meta media download failed: ${fileRes.status}`);

    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const ext      = mimeToExt(mimeType);
    const fileName = originalFileName ?? `${randomUUID()}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    fs.writeFileSync(filePath, buffer);

    return {
      localUrl: `/uploads/${fileName}`,
      mimeType,
      fileName,
    };
  } catch (err) {
    console.error("❌ Failed to download Meta media:", err);
    return null;
  }
}

/** Extract media payload from a Meta webhook message object */
export function extractMediaFromWebhookMessage(message: any): {
  mediaId:   string;
  mimeType:  string;
  caption:   string | null;
  fileName:  string | null;
} | null {
  const type = message?.type as string | undefined;
  if (!type || type === "text" || type === "button" || type === "interactive") return null;

  const payload = message?.[type];
  if (!payload?.id) return null;

  return {
    mediaId:  payload.id as string,
    mimeType: (payload.mime_type as string) ?? "application/octet-stream",
    caption:  (payload.caption as string | undefined) ?? null,
    fileName: (payload.filename as string | undefined) ?? null,
  };
}
