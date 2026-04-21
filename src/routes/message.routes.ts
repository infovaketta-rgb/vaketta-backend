import { Router } from "express";
import multer from "multer";
import { manualReply, getMessages, markMessagesRead, setBotEnabled, sendMedia, deleteMessage, undoSend } from "../controllers/message.controller";
import { requireRole } from "../middleware/role.middleware";
import { UserRole } from "@prisma/client";

const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
  // Video
  "video/mp4", "video/3gpp", "video/quicktime",
  // Audio
  "audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm", "audio/wav",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

const router = Router();

router.post("/reply",     requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF), manualReply);
router.post("/send-media", upload.single("file"), requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF), sendMedia);
router.delete("/:messageId/undo-send", requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER), undoSend);
router.delete("/:messageId",           requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER), deleteMessage);
router.get("/:guestId",       getMessages);
router.post("/:guestId/read", markMessagesRead);
router.patch("/:guestId/bot", requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER), setBotEnabled);

export default router;
