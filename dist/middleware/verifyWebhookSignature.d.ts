import { Request, Response, NextFunction } from "express";
/**
 * Verifies the X-Hub-Signature-256 header that Meta signs every webhook payload with.
 * Rejects requests that don't match — prevents fake webhook injections.
 * Requires WHATSAPP_APP_SECRET in env (your Meta App Secret).
 */
export declare function verifyWebhookSignature(req: Request, res: Response, next: NextFunction): void | Response<any, Record<string, any>>;
//# sourceMappingURL=verifyWebhookSignature.d.ts.map