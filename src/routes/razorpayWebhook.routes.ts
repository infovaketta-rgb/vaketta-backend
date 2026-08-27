import express from "express";
import { handleRazorpayWebhook } from "../controllers/razorpayWebhook.controller";
import { verifyWebhookSignature } from "../services/razorpay.service";
import { getRazorpayWebhookSecret } from "../config/razorpay.config";
import { logger } from "../utils/logger";

const router = express.Router();

/**
 * POST /webhook/razorpay
 *
 * THE PATH IS LOAD-BEARING. `app.ts` skips its JSON body parser for anything
 * matching `req.path.startsWith("/webhook/")`. HMAC must be computed over the
 * exact bytes Razorpay sent, and a body that has been parsed and re-stringified
 * will not match (JSON.stringify preserves neither key order nor whitespace).
 * Mounting this anywhere other than /webhook/razorpay silently breaks every
 * signature check.
 *
 * Order of operations mirrors the Meta webhooks: raw buffer -> verify -> parse
 * -> handle. Verification happens BEFORE parsing so an unsigned request is
 * rejected even when its JSON is malformed.
 */
router.post(
  "/webhook/razorpay",

  express.raw({ type: "application/json", limit: "1mb" }),

  // Keep the exact bytes for HMAC before anything can touch them.
  (req: any, _res, next) => {
    req.rawBody = req.body;
    next();
  },

  // ── Signature verification ────────────────────────────────────────────────
  // FAILS CLOSED. Unlike the Meta webhooks - which skip verification when their
  // secret is unset so local development works - an unverified payment webhook
  // would let anyone mark any invoice paid. A missing secret is a 503, never a
  // bypass.
  (req: any, res: any, next: any) => {
    const secret = getRazorpayWebhookSecret();
    if (!secret) {
      logger.error("RAZORPAY_WEBHOOK_SECRET not set — rejecting webhook (never bypass verification)");
      return res.status(503).json({ error: "Webhook not configured" });
    }

    const signature = req.get("x-razorpay-signature");
    if (!signature) {
      logger.warn("[Razorpay] webhook missing signature");
      return res.status(401).json({ error: "Missing webhook signature" });
    }

    if (!req.rawBody) {
      return res.status(500).json({ error: "Raw body unavailable for signature verification" });
    }

    const valid = verifyWebhookSignature({
      rawBody: req.rawBody,
      signature,
      webhookSecret: secret,
    });

    if (!valid) {
      // Path and length only — never the signature, the secret, or the body.
      logger.warn(
        { path: req.originalUrl, rawBodyLen: req.rawBody.length },
        "[Razorpay] invalid webhook signature",
      );
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    return next();
  },

  // Parse only after the payload is proven authentic. A signed-but-malformed
  // body is Razorpay's bug, not ours — ACK so it stops retrying.
  (req: any, res: any, next: any) => {
    try {
      req.body = JSON.parse(req.rawBody.toString());
    } catch {
      logger.warn("[Razorpay] signed but invalid JSON payload — ACKing to stop retries");
      return res.sendStatus(200);
    }
    return next();
  },

  handleRazorpayWebhook,
);

export default router;
