/**
 * r2.service.ts — Cloudflare R2 media storage (production-grade)
 *
 * Required env vars:
 *   R2_ACCOUNT_ID        — Cloudflare account ID
 *   R2_ACCESS_KEY_ID     — R2 API token access key
 *   R2_SECRET_ACCESS_KEY — R2 API token secret key
 *   R2_BUCKET_NAME       — bucket name (e.g. "vaketta-media")
 *   R2_PUBLIC_URL        — public CDN URL (e.g. "https://media.vaketta.com")
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";

// ── Allowed media types ───────────────────────────────────────────────────────

type AllowedMime =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "video/mp4"
  | "video/3gpp"
  | "audio/ogg"
  | "audio/mpeg"
  | "audio/mp4"
  | "audio/webm"
  | "application/pdf";

const MIME_CONFIG: Record<AllowedMime, { ext: string; maxBytes: number }> = {
  "image/jpeg":       { ext: "jpg",  maxBytes: 16 * 1024 * 1024 },
  "image/png":        { ext: "png",  maxBytes: 16 * 1024 * 1024 },
  "image/webp":       { ext: "webp", maxBytes: 16 * 1024 * 1024 },
  "video/mp4":        { ext: "mp4",  maxBytes: 16 * 1024 * 1024 },
  "video/3gpp":       { ext: "3gp",  maxBytes: 16 * 1024 * 1024 },
  "audio/ogg":        { ext: "ogg",  maxBytes: 16 * 1024 * 1024 },
  "audio/mpeg":       { ext: "mp3",  maxBytes: 16 * 1024 * 1024 },
  "audio/mp4":        { ext: "m4a",  maxBytes: 16 * 1024 * 1024 },
  "audio/webm":       { ext: "webm", maxBytes: 16 * 1024 * 1024 },
  "application/pdf":  { ext: "pdf",  maxBytes: 10 * 1024 * 1024 },
};

// ── R2 client (singleton) ─────────────────────────────────────────────────────

function createR2Client(): S3Client {
  const accountId       = process.env.R2_ACCOUNT_ID;
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 credentials not configured: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY");
  }

  return new S3Client({
    region:   "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

let _client: S3Client | null = null;
function getClient(): S3Client {
  if (!_client) _client = createR2Client();
  return _client;
}

// ── MIME detection ────────────────────────────────────────────────────────────

/**
 * Detect the actual MIME type from the file's magic bytes.
 * Falls back to the client-supplied hint only if detection returns nothing.
 */
async function detectMime(buffer: Buffer, hint: string): Promise<string> {
  try {
    const { fileTypeFromBuffer } = await import("file-type");
    const result = await fileTypeFromBuffer(buffer);
    if (result?.mime) return result.mime;
  } catch {
    // file-type unavailable — fall through to hint
  }
  return hint;
}

// ── Public API ────────────────────────────────────────────────────────────────

export type UploadResult = {
  url:      string;  // full public URL — always https://media.vaketta.com/...
  key:      string;  // R2 object key for deletion
  mime:     string;  // detected MIME type stored in DB
  fileName: string;  // uuid-based filename
};

/**
 * Upload a media buffer to R2 with correct headers for WhatsApp compatibility.
 *
 * - Detects MIME from magic bytes (ignores client claim)
 * - Validates type and size against allowlist
 * - Sets Content-Type, Content-Disposition: inline, CacheControl
 * - Logs URL and MIME before returning
 * - Optionally verifies headers with a HEAD request (pass verify: true)
 */
export async function uploadToR2(
  buffer:   Buffer,
  mimeHint: string,
  options: {
    hotelId?: string;   // used for path scoping: {hotelId}/messages/{uuid}.{ext}
    verify?:  boolean;  // HEAD-check the uploaded object (default: false)
  } = {},
): Promise<UploadResult> {
  const bucket    = process.env.R2_BUCKET_NAME;
  const publicBase = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");

  if (!bucket)    throw new Error("R2_BUCKET_NAME is not set");
  if (!publicBase) throw new Error("R2_PUBLIC_URL is not set");

  // 1. Detect MIME from magic bytes
  const mimeType = await detectMime(buffer, mimeHint);
  const baseMime = mimeType.split(";")[0]!.trim() as AllowedMime;
  const mime = mimeType; // preserve original (with any codec params) for ContentType

  // 2. Validate type
  const config = MIME_CONFIG[baseMime];
  if (!config) {
    throw Object.assign(
      new Error(`Unsupported media type: ${mimeType}. Allowed: ${Object.keys(MIME_CONFIG).join(", ")}`),
      { status: 415 }
    );
  }

  // 3. Validate size
  if (buffer.byteLength > config.maxBytes) {
    const limitMB = (config.maxBytes / 1024 / 1024).toFixed(0);
    throw Object.assign(
      new Error(`File too large for ${baseMime}: max ${limitMB} MB, got ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`),
      { status: 413 }
    );
  }

  // 4. Build scoped key: {hotelId}/messages/{uuid}.{ext}  or  media/{uuid}.{ext}
  const uuid = randomUUID();
  const key = options.hotelId
    ? `${options.hotelId}/messages/${uuid}.${config.ext}`
    : `media/${uuid}.${config.ext}`;

  const fileName = `${uuid}.${config.ext}`;

  // 5. Upload with correct headers
  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket:             bucket,
        Key:                key,
        Body:               buffer,
        ContentType:        mime,
        ContentDisposition: "inline",
        CacheControl:       "public, max-age=31536000, immutable",
      })
    );
  } catch (err: any) {
    console.error("❌ [R2] PutObject failed:", {
      key,
      mime,
      sizeBytes: buffer.byteLength,
      error: err?.message ?? err,
    });
    throw new Error(`R2 upload failed: ${err?.message ?? "unknown error"}`);
  }

  const url = `${publicBase}/${key}`;

  // 6. Log for verification
  console.log("[R2] Uploaded:", { url, mime, sizeKB: Math.round(buffer.byteLength / 1024) });

  // 7. Optional HEAD verification
  if (options.verify) {
    try {
      const head = await getClient().send(
        new HeadObjectCommand({ Bucket: bucket, Key: key })
      );
      console.log("[R2] HEAD verify:", {
        ContentType:        head.ContentType,
        ContentDisposition: head.ContentDisposition,
        ContentLength:      head.ContentLength,
      });
      if (head.ContentType !== mime) {
        console.warn(`⚠️  [R2] Content-Type mismatch: stored=${head.ContentType} expected=${mime}`);
      }
    } catch (err: any) {
      console.warn("⚠️  [R2] HEAD check failed:", err?.message);
    }
  }

  return { url, key, mime: baseMime, fileName };
}

/**
 * Delete an R2 object by its key. Extracts key from full public URL if needed.
 * Safe to call — logs errors but never throws.
 */
export async function deleteFromR2(keyOrUrl: string): Promise<void> {
  const bucket    = process.env.R2_BUCKET_NAME;
  const publicBase = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
  if (!bucket) return;

  // Accept either a bare key or a full URL
  const key = publicBase && keyOrUrl.startsWith(publicBase)
    ? keyOrUrl.slice(publicBase.length + 1)
    : keyOrUrl;

  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    console.log("[R2] Deleted:", key);
  } catch (err: any) {
    console.error("❌ [R2] Delete failed:", { key, error: err?.message ?? err });
  }
}

/** Legacy helper — still used by media.service.ts for incoming WhatsApp media */
export function mimeToExt(mime: string): string {
  const cfg = MIME_CONFIG[mime as AllowedMime];
  if (cfg) return cfg.ext;
  const fallback: Record<string, string> = {
    "image/gif": "gif", "video/quicktime": "mov",
    "audio/wav": "wav", "audio/ogg; codecs=opus": "ogg",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };
  return fallback[mime] ?? "bin";
}

export function isR2Configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME &&
    process.env.R2_PUBLIC_URL
  );
}
