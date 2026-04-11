import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

/**
 * Verifies the X-Hub-Signature-256 header that Meta signs every webhook payload with.
 * Rejects requests that don't match — prevents fake webhook injections.
 * Requires WHATSAPP_APP_SECRET in env (your Meta App Secret).
 */
export function verifyWebhookSignature(req: Request, res: Response, next: NextFunction) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    console.warn("⚠️  WHATSAPP_APP_SECRET not set — skipping webhook signature verification");
    return next();
  }

  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!signature) {
    return res.status(401).json({ error: "Missing webhook signature" });
  }

  // Body must be the raw Buffer — express.json() must NOT have parsed it yet
  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!rawBody) {
    return res.status(500).json({ error: "Raw body unavailable for signature check" });
  }

  const expected = "sha256=" + crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  next();
}
