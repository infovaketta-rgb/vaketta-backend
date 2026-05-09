import { Router } from "express";
import multer from "multer";
import { logger } from "../utils/logger";

const log = logger.child({ service: "message-routes" });
import { manualReply, getMessages, markMessagesRead, setBotEnabled, sendMedia, deleteMessage, undoSend, sendMediaFromUrl } from "../controllers/message.controller";
import { sendTemplateMessage } from "../services/templates.service";
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

    const [messages, total, roomPhotos] = await Promise.all([
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
      prisma.roomPhoto.findMany({
        where:   { roomType: { hotelId } },
        orderBy: { order: "asc" },
        select: {
          id:       true,
          url:      true,
          isMain:   true,
          order:    true,
          roomType: { select: { name: true } },
        },
      }),
    ]);

    const roomPhotoItems = roomPhotos.map((p) => ({
      id:          `rp_${p.id}`,
      mediaUrl:    p.url,
      mimeType:    "image/jpeg",
      fileName:    p.url.split("/").pop() ?? "room-photo.jpg",
      messageType: "image",
      timestamp:   null,
      direction:   "room_photo",
      guest:       { phone: "", name: `${p.roomType.name}${p.isMain ? " ★" : ""}` },
    }));

    res.json({
      data:       [...roomPhotoItems, ...messages],
      total:      total + roomPhotos.length,
      page,
      pages:      Math.ceil((total + roomPhotos.length) / limit),
      roomPhotos: roomPhotoItems.length,
    });
  } catch (err) {
    log.error({ err }, "GET /messages/media failed");
    res.status(500).json({ error: "Failed to fetch media" });
  }
});

router.post("/send-template", requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF), async (req, res) => {
  try {
    const hotelId = (req as any).user.hotelId;
    const { guestId, templateId, values } = req.body;
    if (!guestId || !templateId) return res.status(400).json({ error: "guestId and templateId are required" });
    const result = await sendTemplateMessage(hotelId, guestId, templateId, values ?? {});
    res.json(result);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});
router.post("/send-media-url", requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF), sendMediaFromUrl);
router.post("/reply",     requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF), manualReply);
router.post("/send-media", upload.single("file"), requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF), sendMedia);
router.delete("/:messageId/undo-send", requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER), undoSend);
router.delete("/:messageId",           requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER), deleteMessage);
// GET /messages/:guestId/context  — guest name + latest booking for template auto-fill
router.get("/:guestId/context", async (req, res) => {
  try {
    const hotelId = (req as any).user.hotelId;
    const { guestId } = req.params;

    const [guest, latestBooking] = await Promise.all([
      prisma.guest.findFirst({
        where:  { id: guestId, hotelId },
        select: { name: true, phone: true },
      }),
      prisma.booking.findFirst({
        where:   { guestId, hotelId, status: { in: ["CONFIRMED", "PENDING", "HOLD"] } },
        orderBy: { createdAt: "desc" },
        select: {
          checkIn:         true,
          checkOut:        true,
          referenceNumber: true,
          status:          true,
          roomType:        { select: { name: true } },
        },
      }),
    ]);

    if (!guest) return res.status(404).json({ error: "Guest not found" });

    function fmtDate(d: Date): string {
      return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    }

    res.json({
      guest: { name: guest.name ?? "", phone: guest.phone },
      latestBooking: latestBooking
        ? {
            checkIn:         fmtDate(latestBooking.checkIn),
            checkOut:        fmtDate(latestBooking.checkOut),
            roomTypeName:    latestBooking.roomType?.name ?? "",
            referenceNumber: latestBooking.referenceNumber ?? "",
            status:          latestBooking.status,
          }
        : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:guestId",       getMessages);
router.post("/:guestId/read", markMessagesRead);
router.patch("/:guestId/bot", requireRole(UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER), setBotEnabled);

export default router;
