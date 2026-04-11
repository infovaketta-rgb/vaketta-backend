/**
 * media.service.ts
 *
 * Downloads incoming WhatsApp media from Meta's API and saves it locally.
 * Provides helpers for building media message payloads to send via Meta API.
 */
export type DownloadedMedia = {
    localUrl: string;
    mimeType: string;
    fileName: string;
};
/**
 * Fetch a media file from Meta, save it to ./uploads, return local URL.
 * Returns null if credentials are missing or request fails (graceful mock mode).
 */
export declare function downloadMetaMedia(mediaId: string, mimeType: string, originalFileName?: string): Promise<DownloadedMedia | null>;
/** Extract media payload from a Meta webhook message object */
export declare function extractMediaFromWebhookMessage(message: any): {
    mediaId: string;
    mimeType: string;
    caption: string | null;
    fileName: string | null;
} | null;
//# sourceMappingURL=media.service.d.ts.map