import { Router, Request, Response } from "express";
import {
  exchangeInstagramCodeForToken,
  exchangeForLongLivedToken,
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
 * POST /api/instagram/exchange-code
 * Body: { code: string, redirectUri?: string }
 *
 * Entry point for the config_id-based Facebook-Login-for-Business flow. The
 * frontend FB.login({ config_id, response_type: "code" }) popup returns a `code`;
 * this endpoint exchanges it server-side (FACEBOOK_APP_SECRET, never the client),
 * makes it long-lived, then runs the existing /me/accounts →
 * instagram_business_account lookup.
 *
 * - Exactly one qualifying page → connects it immediately and returns
 *   `{ success: true, instagramBusinessAccountId }`.
 * - Multiple pages → returns `{ needsSelection: true, pages, longLivedToken }` so the
 *   frontend can prompt the user, then call POST /api/instagram/connect with the
 *   chosen pageId + the same longLivedToken (no second code exchange — the auth
 *   code is single-use and already spent here).
 *
 * This absorbs what the old /pages + /connect pair did for the single-page case;
 * the previously-flagged redundant double-exchange (short→long-lived twice) is gone.
 */
router.post("/exchange-code", async (req: Request, res: Response) => {
  try {
    const code        = String(req.body?.code ?? "").trim();
    const redirectUri = String(req.body?.redirectUri ?? "");
    if (!code) return res.status(400).json({ error: "code is required" });

    const hId = hotelId(req); // always from JWT, never from request body

    // 1. Exchange the authorisation code for a user access token (server-side),
    //    then make it long-lived.
    const userToken      = await exchangeInstagramCodeForToken(code, redirectUri);
    const longLivedToken = await exchangeForLongLivedToken(userToken);

    // 2. List Facebook pages that have a linked IG business account.
    const pages = await getPagesWithInstagram(longLivedToken);
    if (pages.length === 0) {
      return res
        .status(400)
        .json({ error: "No Instagram Business accounts found linked to your Facebook pages." });
    }

    // 3a. Multiple pages → let the frontend pick (token returned for the follow-up
    //     /connect call; the spent code cannot be re-exchanged).
    if (pages.length > 1) {
      return res.json({ needsSelection: true, pages, longLivedToken });
    }

    // 3b. Single page → connect immediately.
    const instagramBusinessAccountId = await finishConnect(hId, pages[0]!);
    res.json({ success: true, instagramBusinessAccountId });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/instagram/connect
 * Body: { pageId: string, longLivedToken: string }
 *
 * Second step used ONLY when /exchange-code returned multiple pages. Takes the
 * already-long-lived token from that response (no re-exchange) + the chosen pageId.
 */
router.post("/connect", async (req: Request, res: Response) => {
  try {
    const pageId         = String(req.body?.pageId ?? "");
    const longLivedToken = String(req.body?.longLivedToken ?? "");
    if (!pageId || !longLivedToken) {
      return res.status(400).json({ error: "pageId and longLivedToken are required" });
    }

    const hId   = hotelId(req); // always from JWT, never from request body
    const pages = await getPagesWithInstagram(longLivedToken);
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
