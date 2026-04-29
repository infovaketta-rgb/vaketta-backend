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
 * Incoming Instagram webhook events
 * raw body -> signature verify -> parse -> controller
 *
 * Route registration is deferred until runtime so that a missing
 * INSTAGRAM_APP_SECRET env var degrades gracefully (webhook disabled,
 * logged as a warning) instead of throwing synchronously and crashing
 * the server process — which would also take down WhatsApp and all REST routes.
 */
const instagramAppSecret = process.env.INSTAGRAM_APP_SECRET;

if (instagramAppSecret) {
  router.post(
    "/webhook/instagram",

    express.raw({
      type: "application/json",
      limit: "1mb"
    }),

    (req:any, res, next) => {
      req.rawBody = req.body;

      try {
        req.body = JSON.parse(req.body.toString());
      } catch {
        logger.warn("[Instagram] Invalid JSON payload");
        // always ACK Meta to avoid retries
        return res.sendStatus(200);
      }

      next();
    },

    verifyWebhookSignature(instagramAppSecret),

    handleInstagramWebhook
  );
} else {
  logger.warn(
    "INSTAGRAM_APP_SECRET not set — POST /webhook/instagram is disabled. " +
    "Set the env var and redeploy to enable Instagram messaging."
  );
}

export default router;