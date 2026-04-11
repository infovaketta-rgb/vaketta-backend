/**
 * instagram.routes.ts
 *
 * Instagram DM webhook routes — scaffold for future Instagram channel support.
 *
 * To activate, uncomment the instagram route block in app.ts:
 *   import instagramRoutes from "./routes/instagram.routes";
 *   app.use("/webhook/instagram", webhookLimiter, instagramRoutes);
 *
 * Also requires:
 *   - INSTAGRAM_VERIFY_TOKEN in .env
 *   - INSTAGRAM_APP_SECRET in .env (for HMAC verification)
 *   - Per-hotel igPageId + igAccessToken fields in HotelConfig
 */

import { Router } from "express";
import express from "express";
import { verifyInstagramWebhook, handleInstagramWebhook } from "../controllers/instagram.controller";

const router = Router();

// GET  /webhook/instagram — Meta verification challenge
router.get("/", verifyInstagramWebhook);

// POST /webhook/instagram — incoming DMs and status updates
// Note: raw body + signature verification middleware should be added here
// (same pattern as WhatsApp) before going to production.
router.post(
  "/",
  express.json({ limit: "1mb" }),
  handleInstagramWebhook,
);

export default router;
