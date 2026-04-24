export const MEDIA_LIMITS: Record<string, number> = {
  "image/jpeg":  5  * 1024 * 1024,
  "image/jpg":   5  * 1024 * 1024,
  "image/png":   5  * 1024 * 1024,
  "image/webp":  5  * 1024 * 1024,
  "image/gif":   5  * 1024 * 1024,
  "audio/ogg":   16 * 1024 * 1024,
  "audio/mpeg":  16 * 1024 * 1024,
  "audio/mp4":   16 * 1024 * 1024,
  "audio/webm":  16 * 1024 * 1024,
  "audio/wav":   16 * 1024 * 1024,
  "video/mp4":   16 * 1024 * 1024,
  "video/3gpp":  16 * 1024 * 1024,
  "application/pdf":  100 * 1024 * 1024,
  "application/msword": 100 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 100 * 1024 * 1024,
  "application/vnd.ms-excel": 100 * 1024 * 1024,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 100 * 1024 * 1024,
};

export function getMediaLimit(mimeType: string): number {
  const base = mimeType.split(";")[0]!.trim();
  return MEDIA_LIMITS[base] ?? 5 * 1024 * 1024;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${bytes / (1024 * 1024)} MB`;
  return `${bytes / 1024} KB`;
}
