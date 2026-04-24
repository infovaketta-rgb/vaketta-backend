/**
 * transcode.ts — Convert WebM/Opus audio to OGG/Opus for WhatsApp compatibility.
 *
 * WhatsApp Cloud API accepts audio/ogg (Opus codec) and audio/mpeg, but NOT audio/webm.
 * Browsers record as audio/webm (Chrome default). This utility does a fast re-encode
 * using a bundled ffmpeg binary (ffmpeg-static — no system dependency required).
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

let ffmpegBin: string | null = null;
try {
  ffmpegBin = require("ffmpeg-static") as string;
} catch {
  console.warn("[Transcode] ffmpeg-static not installed — WebM→OGG transcoding disabled");
}

/**
 * Convert a WebM/Opus buffer to an OGG/Opus buffer.
 * Fast re-encode: Opus frames stay the same, only the container changes.
 * Typical latency for a 30-second voice message: ~200–400 ms.
 */
export async function transcodeWebmToOgg(inputBuffer: Buffer): Promise<Buffer> {
  if (!ffmpegBin) {
    throw new Error("ffmpeg-static not available — cannot transcode WebM to OGG");
  }

  const tmpIn  = path.join(os.tmpdir(), `va-${randomUUID()}.webm`);
  const tmpOut = path.join(os.tmpdir(), `va-${randomUUID()}.ogg`);

  try {
    fs.writeFileSync(tmpIn, inputBuffer);

    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegBin!,
        [
          "-y",            // overwrite output without asking
          "-i",  tmpIn,    // input: WebM file
          "-c:a", "libopus", // Opus codec (clean re-encode into OGG container)
          "-f",  "ogg",    // output container: OGG
          tmpOut,
        ],
        { timeout: 30_000 },
        (err) => {
          if (err) reject(new Error(`ffmpeg exited with error: ${err.message}`));
          else resolve();
        }
      );
    });

    const result = fs.readFileSync(tmpOut);
    console.log(`[Transcode] WebM → OGG: ${inputBuffer.length} → ${result.length} bytes`);
    return result;
  } finally {
    fs.rmSync(tmpIn,  { force: true });
    fs.rmSync(tmpOut, { force: true });
  }
}
