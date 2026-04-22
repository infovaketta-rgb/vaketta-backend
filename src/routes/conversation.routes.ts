import { Router } from "express";
import { getConversations, updateGuestName } from "../controllers/conversation.controller";

const router = Router();

router.get("/", getConversations);
router.patch("/:guestId", updateGuestName);

export default router;
