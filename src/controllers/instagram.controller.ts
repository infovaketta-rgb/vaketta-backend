/**
 * instagram.controller.ts
 *
 * Instagram DM webhook scaffold — ready to wire up when Instagram messaging
 * is enabled for Vaketta hotels.
 *
 * To activate:
 *  1. Set INSTAGRAM_VERIFY_TOKEN and INSTAGRAM_APP_SECRET in .env
 *  2. Add per-hotel Instagram credentials to HotelConfig (migration required)
 *  3. Implement logIncomingInstagramMessage() in message.service.ts using the
 *     same pattern as logIncomingMessage() but keying hotels by Instagram WABA ID
 *  4. Uncomment the instagram route in app.ts
 *
 * Meta Instagram Messaging API docs:
 *   https://developers.facebook.com/docs/messenger-platform/instagram
 */

import { Request, Response } from "express";

// ── Webhook verification (GET) ────────────────────────────────────────────────

export function verifyInstagramWebhook(req: Request, res: Response) {
  const mode      = req.query["hub.mode"]         as string | undefined;
  const token     = req.query["hub.verify_token"] as string | undefined;
  const challenge = req.query["hub.challenge"]    as string | undefined;

  const expected = process.env.INSTAGRAM_VERIFY_TOKEN;
  if (!expected) {
    console.warn("⚠️  [Instagram] INSTAGRAM_VERIFY_TOKEN not set");
    return res.sendStatus(403);
  }

  if (mode === "subscribe" && token === expected) {
    console.log("✅ [Instagram] Webhook verified");
    return res.status(200).send(challenge);
  }

  console.warn("❌ [Instagram] Verification failed", { mode, token });
  return res.sendStatus(403);
}

// ── Incoming message handler (POST) ──────────────────────────────────────────

export async function handleInstagramWebhook(req: Request, res: Response) {
  // Always ACK immediately — Meta retries if it doesn't get 200 within 20s
  res.sendStatus(200);

  try {
    const entry  = req.body?.entry?.[0];
    const messaging = entry?.messaging?.[0];

    if (!messaging) return;

    const senderId    = messaging.sender?.id    as string | undefined;
    const recipientId = messaging.recipient?.id as string | undefined;
    const messageText = messaging.message?.text as string | undefined;
    const mid         = messaging.message?.mid  as string | undefined;

    if (!senderId || !recipientId) {
      console.warn("[Instagram] Missing sender/recipient in payload");
      return;
    }

    console.log("[Instagram] Incoming DM:", {
      from:    senderId,
      to:      recipientId,
      mid,
      preview: messageText?.slice(0, 50),
    });

    // TODO: implement when Instagram channel is live
    // await logIncomingInstagramMessage({
    //   igSenderId:    senderId,
    //   igRecipientId: recipientId,
    //   body:          messageText ?? null,
    //   messageType:   "text",
    //   mid,
    // });

  } catch (err) {
    console.error("❌ [Instagram] Webhook handler error:", err);
  }
}
