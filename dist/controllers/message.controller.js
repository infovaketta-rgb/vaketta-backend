"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.manualReply = manualReply;
exports.getMessages = getMessages;
exports.markMessagesRead = markMessagesRead;
exports.setBotEnabled = setBotEnabled;
exports.sendMedia = sendMedia;
const message_service_1 = require("../services/message.service");
const connect_1 = __importDefault(require("../db/connect"));
const client_1 = require("@prisma/client");
const emit_1 = require("../realtime/emit");
const whatsapp_queue_1 = require("../queue/whatsapp.queue");
async function manualReply(req, res) {
    try {
        const { guestId, text } = req.body;
        const hotelId = req.user.hotelId;
        if (!guestId || !text) {
            return res.status(400).json({ error: "guestId and text are required" });
        }
        // Scope lookup to this hotel — prevents cross-tenant guest access
        const guest = await connect_1.default.guest.findFirst({
            where: { id: guestId, hotelId },
            include: { hotel: true },
        });
        if (!guest) {
            return res.status(404).json({ error: "Guest not found" });
        }
        const message = await (0, message_service_1.sendManualReply)({
            hotelId,
            guestId,
            fromPhone: guest.hotel.phone,
            toPhone: guest.phone,
            text,
        });
        res.json(message);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Send failed" });
    }
}
async function getMessages(req, res) {
    try {
        const guestId = req.params.guestId;
        if (!guestId) {
            return res.status(400).json({ error: "guestId required" });
        }
        const hotelId = req.user.hotelId;
        const messages = await connect_1.default.message.findMany({
            where: {
                guestId,
                hotelId, // 🔒 isolation enforced
            },
            orderBy: { timestamp: "asc" },
        });
        return res.json(messages);
    }
    catch (err) {
        console.error("❌ Get messages failed:", err);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error",
        });
    }
}
/*** POST /messages/:guestId/read*/
async function markMessagesRead(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const { guestId } = req.params;
        if (!guestId) {
            return res.status(400).json({ error: "guestId required" });
        }
        // Mark unread incoming messages as READ
        await connect_1.default.message.updateMany({
            where: {
                guestId,
                hotelId,
                direction: "IN",
                status: client_1.MessageStatus.RECEIVED,
            },
            data: { status: client_1.MessageStatus.READ },
        });
        // 🔥 EMIT REALTIME EVENT
        (0, emit_1.emitToHotel)(hotelId, "message:read", { guestId });
        return res.json({ success: true });
    }
    catch (err) {
        console.error("❌ Mark read failed:", err);
        return res.status(500).json({ error: "Failed to mark read" });
    }
}
/** PATCH /messages/:guestId/bot — toggle bot on/off for a guest */
async function setBotEnabled(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const guestId = req.params["guestId"];
        const { enabled } = req.body;
        if (!guestId)
            return res.status(400).json({ error: "guestId required" });
        if (typeof enabled !== "boolean") {
            return res.status(400).json({ error: "enabled (boolean) is required" });
        }
        const guest = await connect_1.default.guest.findFirst({ where: { id: guestId, hotelId } });
        if (!guest)
            return res.status(404).json({ error: "Guest not found" });
        await connect_1.default.guest.update({
            where: { id: guest.id },
            data: { lastHandledByStaff: !enabled },
        });
        return res.json({ success: true, botEnabled: enabled });
    }
    catch (err) {
        console.error("❌ setBotEnabled failed:", err);
        return res.status(500).json({ error: "Failed to update bot status" });
    }
}
/** POST /messages/send-media — staff sends a media file to a guest */
async function sendMedia(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const file = req.file;
        if (!file)
            return res.status(400).json({ error: "No file uploaded" });
        const { guestId, caption } = req.body;
        if (!guestId)
            return res.status(400).json({ error: "guestId is required" });
        const guest = await connect_1.default.guest.findFirst({
            where: { id: guestId, hotelId },
            include: { hotel: true },
        });
        if (!guest)
            return res.status(404).json({ error: "Guest not found" });
        const mime = file.mimetype;
        const messageType = mime.startsWith("image/") ? "image"
            : mime.startsWith("video/") ? "video"
                : mime.startsWith("audio/") ? "audio"
                    : "document";
        const mediaUrl = `/uploads/${file.filename}`;
        // Mark as staff-handled and reset bot session
        await connect_1.default.guest.update({ where: { id: guest.id }, data: { lastHandledByStaff: true } });
        const message = await connect_1.default.message.create({
            data: {
                direction: "OUT",
                fromPhone: guest.hotel.phone,
                toPhone: guest.phone,
                body: caption ?? null,
                messageType,
                mediaUrl,
                mimeType: mime,
                fileName: file.originalname,
                hotelId,
                guestId: guest.id,
                status: client_1.MessageStatus.PENDING,
            },
        });
        (0, emit_1.emitToHotel)(hotelId, "message:new", { message });
        await whatsapp_queue_1.whatsappQueue.add("send", { messageId: message.id });
        return res.json(message);
    }
    catch (err) {
        console.error("❌ sendMedia failed:", err);
        return res.status(500).json({ error: "Failed to send media" });
    }
}
//# sourceMappingURL=message.controller.js.map