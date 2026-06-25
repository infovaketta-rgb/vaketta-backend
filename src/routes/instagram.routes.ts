import express from "express";
import {
  verifyInstagramWebhook,
  handleInstagramWebhook
} from "../controllers/instagram.controller";
import { logger } from "../utils/logger";
import {
  verifyWebhookSignature
} from "../middleware/verifyWebhookSignature";

const router = express.Router();

/**
 * Meta webhook verification challenge
 * Used when clicking "Verify and Save" in Meta dashboard
 */
router.get(
  "/webhook/instagram",
  verifyInstagramWebhook
);

/**
 * Incoming Instagram webhook events — always registered.
 * Signature verification is enforced when FACEBOOK_APP_SECRET is set;
 * if missing, the request is accepted but a warning is logged.
 */
const instagramAppSecret = process.env.FACEBOOK_APP_SECRET?.trim();

if (!instagramAppSecret) {
  logger.warn(
    "FACEBOOK_APP_SECRET not set — Instagram webhook signature verification is DISABLED. " +
    "Set the env var in production to secure the endpoint."
  );
}

router.post(
  "/webhook/instagram",

  express.raw({ type: "application/json", limit: "1mb" }),

  // Save raw buffer BEFORE any parsing — HMAC must run on the exact bytes Meta sent.
  (req: any, _res: any, next: any) => {
    req.rawBody = req.body;
    next();
  },

  // Signature verification — skip only when secret is not configured (dev/unconfigured)
  (req: any, res: any, next: any) => {
    if (!instagramAppSecret) return next();
    return verifyWebhookSignature(instagramAppSecret, "FACEBOOK_APP_SECRET")(req, res, next);
  },

  // Parse JSON after signature is confirmed. ACK Meta on malformed payloads
  // so it does not retry — malformed but signed bodies are Meta bugs, not ours.
  (req: any, res: any, next: any) => {
    try {
      req.body = JSON.parse(req.rawBody.toString());
    } catch {
      logger.warn("[Instagram] Signed but invalid JSON payload — ACKing to stop retries");
      return res.sendStatus(200);
    }
    next();
  },

  handleInstagramWebhook
);

export default router;