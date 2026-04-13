/**
 * media.service.ts
 *
 * Downloads incoming WhatsApp media from Meta's API and uploads it to R2.
 * Falls back to local disk storage if R2 is not configured (dev mode).
 *
 * Access token is read per-hotel from HotelConfig.metaAccessToken (set via
 * the hotel's WhatsApp integration settings in the frontend).
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import prisma from "../db/connect";
import { uploadToR2, isR2Configured, mimeToExt } from "./r2.service";

const META_API_VERSION = "v25.0";

// Local fallback directory (dev only)
const UPLOADS_DIR = path.join(process.cwd(), "uploads");

export type DownloadedMedia = {
  localUrl:  string;   // R2 public URL in prod, "/uploads/..." in dev
  mimeType:  string;
  fileName:  string;
};

/**
 * Fetch a media file from Meta, store it in R2 (prod) or local disk (dev).
 * Returns null if credentials are missing or request fails.
 *
 * @param toPhone - hotel's WhatsApp number, used to resolve the per-hotel access token
 */
export async function downloadMetaMedia(
  mediaId:           string,
  mimeType:          string,
  toPhone:           string,
  originalFileName?: string
): Promise<DownloadedMedia | null> {
  // Resolve per-hotel Meta access token from DB
  const hotel = await prisma.hotel.findUnique({
    where:  { phone: toPhone },
    select: { config: { select: { metaAccessToken: true } } },
  });
  const accessToken = hotel?.config?.metaAccessToken ?? "";

  if (!accessToken) {
    console.warn(`⚠️  No metaAccessToken configured for hotel ${toPhone} — skipping media download`);
    return null;
  }

  try {
    // Step 1: Get download URL from Meta
    const infoRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal:  AbortSignal.timeout(10_000),
      }
    );
    if (!infoRes.ok) throw new Error(`Meta media info failed: ${infoRes.status}`);

    const info = (await infoRes.json()) as { url?: string };
    if (!info.url) throw new Error("No URL in Meta media response");

    // Step 2: Download the file into memory
    const fileRes = await fetch(info.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal:  AbortSignal.timeout(30_000),
    });
    if (!fileRes.ok) throw new Error(`Meta media download failed: ${fileRes.status}`);

    const buffer = Buffer.from(await fileRes.arrayBuffer());

    // Step 3a: Upload to R2 (production)
    if (isR2Configured()) {
      const uploaded = await uploadToR2(buffer, mimeType, originalFileName ?? null);
      return {
        localUrl: uploaded.url,
        mimeType,
        fileName: uploaded.fileName,
      };
    }

    // Step 3b: Save to local disk (development fallback)
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    const ext      = mimeToExt(mimeType);
    const fileName = originalFileName ?? `${randomUUID()}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, fileName);
    fs.writeFileSync(filePath, buffer);

    console.warn("⚠️  R2 not configured — saved media to local disk:", filePath);

    return {
      localUrl: `/uploads/${fileName}`,
      mimeType,
      fileName,
    };
  } catch (err) {
    console.error("❌ Failed to download/store media:", err);
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
