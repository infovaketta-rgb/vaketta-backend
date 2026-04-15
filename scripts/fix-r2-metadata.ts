/**
 * scripts/fix-r2-metadata.ts
 *
 * One-shot script: copies every object in the R2 bucket back to itself
 * with correct Content-Type, Content-Disposition: inline, and CacheControl.
 *
 * Run:
 *   npx ts-node scripts/fix-r2-metadata.ts
 *
 * Dry-run (no writes):
 *   DRY_RUN=true npx ts-node scripts/fix-r2-metadata.ts
 */

import "./src/loadEnv"; // populate process.env from .env / .env.production
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";

const BUCKET    = process.env.R2_BUCKET_NAME!;
const ACCOUNT   = process.env.R2_ACCOUNT_ID!;
const KEY_ID    = process.env.R2_ACCESS_KEY_ID!;
const SECRET    = process.env.R2_SECRET_ACCESS_KEY!;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
const DRY_RUN   = process.env.DRY_RUN === "true";

if (!BUCKET || !ACCOUNT || !KEY_ID || !SECRET) {
  console.error("Missing R2 env vars. Set R2_BUCKET_NAME, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.");
  process.exit(1);
}

const client = new S3Client({
  region:   "auto",
  endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
});

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  mov: "video/quicktime",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  webm: "audio/webm",
  wav: "audio/wav",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function mimeFromKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

async function main() {
  console.log(`🪣  Bucket: ${BUCKET}${DRY_RUN ? "  [DRY RUN]" : ""}`);

  let processed = 0;
  let fixed     = 0;
  let skipped   = 0;
  let token: string | undefined;

  do {
    const list = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token })
    );

    for (const obj of list.Contents ?? []) {
      const key = obj.Key!;
      processed++;

      const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));

      const currentType        = head.ContentType        ?? "";
      const currentDisposition = head.ContentDisposition ?? "";
      const expectedType       = mimeFromKey(key);

      const needsFix =
        currentType !== expectedType ||
        !currentDisposition.includes("inline");

      if (!needsFix) {
        skipped++;
        continue;
      }

      console.log(`  ${DRY_RUN ? "[dry]" : "fix "} ${key}`);
      console.log(`       Content-Type: ${currentType || "(none)"} → ${expectedType}`);
      console.log(`       Content-Disposition: ${currentDisposition || "(none)"} → inline`);

      if (!DRY_RUN) {
        await client.send(
          new CopyObjectCommand({
            Bucket:             BUCKET,
            CopySource:         `${BUCKET}/${key}`,
            Key:                key,
            ContentType:        expectedType,
            ContentDisposition: "inline",
            CacheControl:       "public, max-age=31536000, immutable",
            MetadataDirective:  "REPLACE",
          })
        );
        // Verify
        const verify = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        const url    = `${PUBLIC_URL}/${key}`;
        console.log(`    ✅ verified: Content-Type=${verify.ContentType}  URL: ${url}`);
      }

      fixed++;
    }

    token = list.NextContinuationToken;
  } while (token);

  console.log(`\nDone. Processed: ${processed} | Fixed: ${fixed} | Already correct: ${skipped}`);
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
