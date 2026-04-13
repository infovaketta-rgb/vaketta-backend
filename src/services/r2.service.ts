/**
 * r2.service.ts
 *
 * Cloudflare R2 storage integration using the S3-compatible API.
 *
 * Required env vars:
 *   R2_ACCOUNT_ID      — Cloudflare account ID
 *   R2_ACCESS_KEY_ID   — R2 API token Access Key ID
 *   R2_SECRET_ACCESS_KEY — R2 API token Secret Access Key
 *   R2_BUCKET_NAME     — bucket name (e.g. "vaketta-media")
 *   R2_PUBLIC_URL      — public bucket URL (e.g. "https://media.vaketta.com")
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";

// ── Client (singleton) ────────────────────────────────────────────────────────

function createR2Client(): S3Client {
  const accountId      = process.env.R2_ACCOUNT_ID;
  const accessKeyId    = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 credentials not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."
    );
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) _client = createR2Client();
  return _client;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map mime types to file extensions */
export function mimeToExt(mime: string): string {
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

/** Build a consistent object key: media/{uuid}.{ext} */
function buildKey(mimeType: string, originalFileName?: string | null): string {
  const ext = originalFileName
    ? originalFileName.split(".").pop() ?? mimeToExt(mimeType)
    : mimeToExt(mimeType);
  return `media/${randomUUID()}.${ext}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export type UploadResult = {
  url:      string;   // public URL to store in DB
  key:      string;   // R2 object key (for future deletion)
  fileName: string;   // derived filename
};

/**
 * Upload a buffer to R2 and return the public URL.
 *
 * @param buffer   — file content
 * @param mimeType — MIME type (e.g. "image/jpeg")
 * @param originalFileName — optional original name to preserve extension
 */
export async function uploadToR2(
  buffer:           Buffer,
  mimeType:         string,
  originalFileName?: string | null,
): Promise<UploadResult> {
  const bucket    = process.env.R2_BUCKET_NAME;
  const publicUrl = process.env.R2_PUBLIC_URL;

  if (!bucket)    throw new Error("R2_BUCKET_NAME is not set");
  if (!publicUrl) throw new Error("R2_PUBLIC_URL is not set");

  const key      = buildKey(mimeType, originalFileName);
  const fileName = key.split("/").pop()!;

  await getClient().send(
    new PutObjectCommand({
      Bucket:      bucket,
      Key:         key,
      Body:        buffer,
      ContentType: mimeType,
    })
  );

  return {
    url:      `${publicUrl.replace(/\/$/, "")}/${key}`,
    key,
    fileName,
  };
}

/**
 * Delete an object from R2 by its key.
 * Safe to call with a non-R2 URL — it will be a no-op.
 */
export async function deleteFromR2(key: string): Promise<void> {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) return;

  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key })
    );
  } catch (err) {
    console.error("❌ [R2] Failed to delete object:", key, err);
  }
}

/**
 * Returns true if R2 is configured (all required env vars present).
 * Use this to decide whether to fall back to local storage.
 */
export function isR2Configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME &&
    process.env.R2_PUBLIC_URL
  );
}
