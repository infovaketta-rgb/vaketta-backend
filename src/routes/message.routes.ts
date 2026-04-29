import { Router } from "express";
import multer from "multer";
import { logger } from "../utils/logger";

const log = logger.child({ service: "message-routes" });
import { manualReply, getMessages, markMessagesRead, setBotEnabled, sendMedia, deleteMessage, undoSend, sendMediaFromUrl } from "../controllers/message.controller";
import { requireRole } from "../middleware/role.middleware";
import { UserRole } from "@prisma/client";
import prisma from "../db/connect";

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
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB — per-type limits enforced in controller
  fileFilter: (_req, file, cb) => {
    // Strip codec params (e.g. "audio/webm;codecs=opus" → "audio/webm") before allowlist check
    const base = file.mimetype.split(";")[0]!.trim();
    if (ALLOWED_MIME_TYPES.has(base)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

const router = Router();

router.get("/media", async (req, res) => {
  try {
    const hotelId = (req as any).user.hotelId;
    const page  = parseInt(req.query.page as string) || 1;
    const limit = 50;

    const where = {
      hotelId,
      mediaUrl: { not: null as null },
      deleted:  false,
      NOT: [
        { mediaUrl: { startsWith: "meta://" } },
        { mediaUrl: { startsWith: "pending://" } },
      ],
    };

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip:    (page - 1) * limit,
        take:    limit,
        select: {
          id:          true,
          mediaUrl:    true,
          mimeType:    true,
          fileName:    true,
          messageType: true,
          timestamp:   true,
          direction:   true,
          guest:       { select: { phone: true, name: true } },
        },
      }),
      prisma.message.count({ where }),
    ]);

    res.json({ data: messages, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    log.error({ err }, "GET /messages/media failed");
    res.status(500).json({ error: "Failed to fetch media" });
  }
});

router.post("/send-media-url", requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF), sendMediaFromUrl);
router.post("/reply",     requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF), manualReply);
router.post("/send-media", upload.single("file"), requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF), sendMedia);
router.delete("/:messageId/undo-send", requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER), undoSend);
router.delete("/:messageId",           requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER), deleteMessage);
router.get("/:guestId",       getMessages);
router.post("/:guestId/read", markMessagesRead);
router.patch("/:guestId/bot", requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER), setBotEnabled);

export default router;
