import { Router } from "express";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import { manualReply, getMessages, markMessagesRead, setBotEnabled, sendMedia } from "../controllers/message.controller";

const storage = multer.diskStorage({
  destination: path.join(process.cwd(), "uploads"),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${randomUUID()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 64 * 1024 * 1024 } }); // 64 MB max

const router = Router();

router.post("/reply", manualReply);
router.post("/send-media", upload.single("file"), sendMedia);
router.get("/:guestId", getMessages);
router.post("/:guestId/read", markMessagesRead);
router.patch("/:guestId/bot", setBotEnabled);

export default router;
