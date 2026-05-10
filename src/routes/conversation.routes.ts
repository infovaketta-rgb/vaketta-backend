import { Router, Request, Response } from "express";
import { getConversations, updateGuestName } from "../controllers/conversation.controller";
import { normalizePhone } from "../utils/phone";
import prisma from "../db/connect";

const router = Router();

router.get("/", getConversations);
router.patch("/:guestId", updateGuestName);

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
