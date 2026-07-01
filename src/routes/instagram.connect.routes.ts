import { Router, Request, Response } from "express";
import { connectInstagram } from "../services/instagram.auth.service";

const router = Router();

function hotelId(req: Request): string {
  return (req as any).user.hotelId;
}

/**
 * POST /api/instagram/exchange-code
 * Body: { code: string, redirectUri: string }
 *
 * Business Login for Instagram flow (no Facebook Page required):
 *   1. Frontend redirects to instagram.com/oauth/authorize → user grants access → ?code= returned
 *   2. Frontend POSTs the code here (HTTPS body — code is single-use, never logged in full)
 *   3. This endpoint exchanges it for a short-lived token, then a long-lived token,
 *      confirms the IG account, and writes to HotelConfig.
 *
 * Webhooks are subscribed at the app level in Meta Dashboard (not per-connection in code).
 */
router.post("/exchange-code", async (req: Request, res: Response) => {
  try {
    const code        = String(req.body?.code        ?? "").trim();
    const redirectUri = String(req.body?.redirectUri ?? "").trim();

    if (!code)        return res.status(400).json({ error: "code is required" });
    if (!redirectUri) return res.status(400).json({ error: "redirectUri is required" });

    const hId = hotelId(req); // always from JWT, never from body

    console.log("[ig-connect] /exchange-code — code len:", code.length, "redirectUri:", redirectUri);

    const { instagramBusinessAccountId, username } = await connectInstagram(hId, code, redirectUri);

    res.json({ success: true, instagramBusinessAccountId, username });
  } catch (err: any) {
    console.error("[ig-connect] exchange-code error:", err?.message);
    res.status(502).json({ error: err.message ?? "Failed to connect Instagram account" });
  }
});

export default router;
