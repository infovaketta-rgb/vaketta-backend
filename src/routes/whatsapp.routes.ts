import express from "express";
import {
  handleWhatsAppWebhook,
  verifyWhatsAppWebhook
} from "../controllers/whatsapp.controller";
import { logger } from "../utils/logger";
import {
  verifyWebhookSignature
} from "../middleware/verifyWebhookSignature";

const router = express.Router();

/**
 * Meta webhook verification challenge
 */
router.get(
  "/webhook/whatsapp",
  verifyWhatsAppWebhook
);

/**
 * Incoming WhatsApp webhooks
 * raw body -> verify signature -> parse JSON -> controller
 */
router.post(
  "/webhook/whatsapp",

  express.raw({
    type: "application/json",
    limit: "1mb"
  }),

  // Save raw body for HMAC verification, then verify signature BEFORE parsing.
  // This ensures unauthenticated requests are rejected even when JSON is malformed.
  (req: any, _res, next) => {
    req.rawBody = req.body;
    next();
  },

  verifyWebhookSignature(
    process.env.FACEBOOK_APP_SECRET!
  ),

  // Parse JSON after signature is confirmed. ACK Meta on malformed payloads
  // so it does not retry — malformed but signed bodies are Meta bugs, not ours.
  (req: any, res, next) => {
    try {
      req.body = JSON.parse(req.rawBody.toString());
    } catch {
      logger.warn("[WhatsApp] Signed but invalid JSON payload — ACKing to stop retries");
      return res.sendStatus(200);
    }
    next();
  },

  handleWhatsAppWebhook
);

export default router;