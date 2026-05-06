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
 * raw body -> parse -> verify signature -> controller
 */
router.post(
  "/webhook/whatsapp",

  express.raw({
    type: "application/json",
    limit: "1mb"
  }),

  (req:any,res,next)=>{
    req.rawBody = req.body;

    try{
      req.body = JSON.parse(
        req.body.toString()
      );
    } catch {
      logger.warn(
        "[WhatsApp] Invalid JSON payload"
      );

      // Always ACK Meta to prevent retries
      return res.sendStatus(200);
    }

    next();
  },

  verifyWebhookSignature(
    process.env.FACEBOOK_APP_SECRET!
  ),

  handleWhatsAppWebhook
);

export default router;