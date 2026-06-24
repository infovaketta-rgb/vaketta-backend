import { Router, Request, Response } from "express";
import {
  getPagesWithInstagram,
  connectInstagramViaPage,
  subscribePageToWebhook,
} from "../services/instagram.auth.service";

const router = Router();

function hotelId(req: Request): string {
  return (req as any).user.hotelId;
}

/** Connect the resolved page: save token + subscribe webhook. Shared by both paths. */
async function finishConnect(hId: string, page: { id: string; accessToken: string }) {
  const { instagramBusinessAccountId } = await connectInstagramViaPage(
    hId,
    page.id,
    page.accessToken,
  );
  // Subscribe the page to the Meta webhook for DMs (unchanged downstream).
  await subscribePageToWebhook(hId, page.id, page.accessToken);
  return instagramBusinessAccountId;
}

/**
 * POST /api/instagram/connect-with-token
 * Body: { accessToken: string, pageId?: string }
 *
 * Entry point for the "Facebook Login for Business / IG_API_ONBOARDING" flow. The
 * frontend uses Meta's manual redirect dialog
 *   facebook.com/<v>/dialog/oauth?...&response_type=token&extras={"setup":{"channel":"IG_API_ONBOARDING"}}
 * which returns the access token DIRECTLY in the redirect URL fragment — there is NO
 * server-side code→token exchange in this flow. The client parses the token from the
 * fragment and POSTs it here (HTTPS body, never the query string / never logged in full).
 *
 * This endpoint takes that user access token and runs the existing
 * /me/accounts → instagram_business_account lookup.
 *
 * - Exactly one qualifying page → connects it immediately and returns
 *   `{ success: true, instagramBusinessAccountId }`.
 * - Multiple pages → returns `{ needsSelection: true, pages, accessToken }` so the
 *   frontend can prompt the user, then call POST /api/instagram/connect with the chosen
 *   pageId + the same accessToken.
 */
router.post("/connect-with-token", async (req: Request, res: Response) => {
  try {
    const accessToken = String(req.body?.accessToken ?? "").trim();
    if (!accessToken) return res.status(400).json({ error: "accessToken is required" });

    const hId = hotelId(req); // always from JWT, never from request body

    // TEMP DIAGNOSTIC (remove after debugging): never log the raw token — length only.
    console.log("[ig-connect] /connect-with-token — token len:", accessToken.length);

    // List Facebook pages that have a linked IG business account, using the token
    // the client obtained directly from the login redirect fragment.
    const pages = await getPagesWithInstagram(accessToken);
    if (pages.length === 0) {
      return res
        .status(400)
        .json({ error: "No Instagram Business accounts found linked to your Facebook pages." });
    }

    // Multiple pages → let the frontend pick (token returned for the follow-up call).
    if (pages.length > 1) {
      return res.json({ needsSelection: true, pages, accessToken });
    }

    // Single page → connect immediately.
    const instagramBusinessAccountId = await finishConnect(hId, pages[0]!);
    res.json({ success: true, instagramBusinessAccountId });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/instagram/connect
 * Body: { pageId: string, accessToken: string }
 *
 * Second step used ONLY when /connect-with-token returned multiple pages. Takes the
 * user access token from that response + the chosen pageId.
 */
router.post("/connect", async (req: Request, res: Response) => {
  try {
    const pageId      = String(req.body?.pageId ?? "");
    const accessToken = String(req.body?.accessToken ?? "");
    if (!pageId || !accessToken) {
      return res.status(400).json({ error: "pageId and accessToken are required" });
    }

    const hId   = hotelId(req); // always from JWT, never from request body
    const pages = await getPagesWithInstagram(accessToken);
    const page  = pages.find((p) => p.id === pageId);
    if (!page) {
      return res
        .status(400)
        .json({ error: "Selected page not found or has no linked Instagram account" });
    }

    const instagramBusinessAccountId = await finishConnect(hId, page);
    res.json({ success: true, instagramBusinessAccountId });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
