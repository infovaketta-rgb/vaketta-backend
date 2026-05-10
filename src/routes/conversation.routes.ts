import { Router, Request, Response, json as expressJson } from "express";
import { getConversations, updateGuestName } from "../controllers/conversation.controller";
import { normalizePhone } from "../utils/phone";
import prisma from "../db/connect";

const router = Router();

router.get("/", getConversations);
router.patch("/:guestId", updateGuestName);

// ── DELETE /conversations/bulk ────────────────────────────────────────────────
// Must be declared BEFORE /:guestId so Express doesn't treat "bulk" as a guestId.
// body: { guestIds: string[], action: "delete" | "clear" }
router.delete("/bulk", expressJson({ strict: false, limit: "1mb" }), async (req: Request, res: Response) => {
  const hotelId = (req as any).user.hotelId as string;

  // Guard against unparsed body (body parser may not run for DELETE on some setups)
  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({ error: "Request body is missing or not JSON" });
  }

  const { guestIds, action } = req.body as { guestIds?: string[]; action?: string };

  if (!Array.isArray(guestIds) || guestIds.length === 0) {
    return res.status(400).json({ error: "guestIds must be a non-empty array" });
  }
  if (action !== "delete" && action !== "clear") {
    return res.status(400).json({ error: "action must be 'delete' or 'clear'" });
  }

  // Verify ALL guestIds belong to this hotel before touching anything
  const owned = await prisma.guest.findMany({
    where: { id: { in: guestIds }, hotelId },
    select: { id: true },
  });
  if (owned.length !== guestIds.length) {
    return res.status(404).json({ error: "One or more conversations not found" });
  }
  const ownedIds = owned.map((g) => g.id);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const { count } = await tx.message.deleteMany({
        where: { guestId: { in: ownedIds }, hotelId },
      });
      return count;
    });

    return res.json({ success: true, affected: result });
  } catch (err) {
    console.error("bulk conversation action error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── DELETE /conversations/:guestId ────────────────────────────────────────────
// Deletes all messages for this guest. Guest record is NOT deleted.
router.delete("/:guestId", async (req: Request, res: Response) => {
  const hotelId = (req as any).user.hotelId as string;
  const guestId = req.params["guestId"] as string;

  const guest = await prisma.guest.findFirst({
    where: { id: guestId, hotelId },
  });
  if (!guest) return res.status(404).json({ error: "Not found" });

  try {
    await prisma.message.deleteMany({ where: { guestId, hotelId } });
    return res.json({ success: true });
  } catch (err) {
    console.error("delete conversation error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── DELETE /conversations/:guestId/messages ───────────────────────────────────
// Clears all messages but keeps the guest / conversation intact.
router.delete("/:guestId/messages", async (req: Request, res: Response) => {
  const hotelId = (req as any).user.hotelId as string;
  const guestId = req.params["guestId"] as string;

  const guest = await prisma.guest.findFirst({
    where: { id: guestId, hotelId },
  });
  if (!guest) return res.status(404).json({ error: "Not found" });

  try {
    const { count } = await prisma.message.deleteMany({ where: { guestId, hotelId } });
    return res.json({ success: true, deletedMessages: count });
  } catch (err) {
    console.error("clear chat error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /conversations/initiate
// Body: { guestId: string } | { phone: string; name?: string }
// Returns { guestId } — creates the guest record if it doesn't exist yet.
// Does NOT send any WhatsApp message; the staff sends the first message from ChatWindow.
router.post("/initiate", async (req: Request, res: Response) => {
  const hotelId = (req as any).user.hotelId as string;

  try {
    let guest;

    if (req.body.guestId) {
      // Existing guest — verify it belongs to this hotel
      guest = await prisma.guest.findFirst({
        where: { id: String(req.body.guestId), hotelId },
      });
      if (!guest) return res.status(404).json({ error: "Guest not found" });

    } else if (req.body.phone) {
      const phone = normalizePhone(String(req.body.phone));
      // Upsert: returns existing guest or creates a new one
      guest = await prisma.guest.upsert({
        where:  { phone_hotelId: { phone, hotelId } },
        update: {},
        create: { hotelId, phone, name: req.body.name?.trim() || null },
      });

    } else {
      return res.status(400).json({ error: "Provide guestId or phone" });
    }

    return res.json({ guestId: guest.id });
  } catch (err) {
    console.error("initiate conversation error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
