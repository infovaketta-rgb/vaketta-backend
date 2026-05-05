import { Router, Request, Response } from "express";
import {
  exchangeForLongLivedToken,
  getPagesWithInstagram,
  connectInstagramViaPage,
  subscribePageToWebhook,
} from "../services/instagram.auth.service";

const router = Router();

function hotelId(req: Request): string {
  return (req as any).user.hotelId;
}

// GET /api/instagram/pages?token={shortLivedUserToken}
router.get("/pages", async (req: Request, res: Response) => {
  try {
    const token = String(req.query.token ?? "").trim();
    if (!token) return res.status(400).json({ error: "token is required" });

    const longLivedToken = await exchangeForLongLivedToken(token);
    const pages          = await getPagesWithInstagram(longLivedToken);
    res.json({ pages });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/instagram/connect
// Body: { pageId: string, shortLivedToken: string }
router.post("/connect", async (req: Request, res: Response) => {
  try {
    const { pageId, shortLivedToken } = req.body;
    if (!pageId || !shortLivedToken) {
      return res.status(400).json({ error: "pageId and shortLivedToken are required" });
    }

    const hId = hotelId(req); // always from JWT, never from request body

    // 1. Exchange short-lived user token for long-lived user token
    const longLivedToken = await exchangeForLongLivedToken(shortLivedToken);

    // 2. Resolve the page access token for the selected page
    const pages = await getPagesWithInstagram(longLivedToken);
    const page  = pages.find((p) => p.id === pageId);
    if (!page) {
      return res
        .status(400)
        .json({ error: "Selected page not found or has no linked Instagram account" });
    }

    // 3. Save encrypted page access token + metadata (hotelId from JWT)
    const { instagramBusinessAccountId } = await connectInstagramViaPage(
      hId,
      pageId,
      page.accessToken
    );

    // 4. Subscribe the page to the Meta webhook for DMs
    await subscribePageToWebhook(hId, pageId, page.accessToken);

    res.json({ success: true, instagramBusinessAccountId });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
