import { Router } from "express";
import multer from "multer";
import { manualReply, getMessages, markMessagesRead, setBotEnabled, sendMedia, deleteMessage, undoSend } from "../controllers/message.controller";

// Use memory storage — the controller decides where to persist the file
// (R2 in production, local disk in development)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } }); // 64 MB max

const router = Router();

router.post("/reply", manualReply);
router.post("/send-media", upload.single("file"), sendMedia);
router.delete("/:messageId/undo-send", undoSend);
router.delete("/:messageId", deleteMessage);
router.get("/:guestId", getMessages);
router.post("/:guestId/read", markMessagesRead);
router.patch("/:guestId/bot", setBotEnabled);

export default router;
