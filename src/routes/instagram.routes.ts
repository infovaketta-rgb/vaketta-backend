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
const instagramAppSecret = process.env.FACEBOOK_APP_SECRET;

if (!instagramAppSecret) {
  logger.warn(
    "FACEBOOK_APP_SECRET not set — Instagram webhook signature verification is DISABLED. " +
    "Set the env var in production to secure the endpoint."
  );
}

router.post(
  "/webhook/instagram",

  express.raw({ type: "application/json", limit: "1mb" }),

  // Parse raw body → JSON, keep rawBody for signature check
  (req: any, res: any, next: any) => {
    req.rawBody = req.body;
    try {
      req.body = JSON.parse(req.body.toString());
    } catch {
      logger.warn("[Instagram] Invalid JSON payload — ACKing to prevent Meta retries");
      return res.sendStatus(200);
    }
    next();
  },

  // Signature verification — skip only when secret is not configured (dev/unconfigured)
  (req: any, res: any, next: any) => {
    if (!instagramAppSecret) return next();
    return verifyWebhookSignature(instagramAppSecret)(req, res, next);
  },

  handleInstagramWebhook
);

export default router;