"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bullmq_1 = require("bullmq");
const connect_1 = __importDefault(require("../db/connect"));
const redis_1 = require("../queue/redis");
const whatsapp_send_service_1 = require("../services/whatsapp.send.service");
const client_1 = require("@prisma/client");
const statusBus_1 = require("../realtime/statusBus");
console.log("🚀 WhatsApp worker booting...");
new bullmq_1.Worker("whatsapp-out", async (job) => {
    const { messageId } = job.data;
    const message = await connect_1.default.message.findUnique({
        where: { id: messageId },
    });
    if (!message || message.status !== "PENDING")
        return;
    try {
        const isMedia = ["image", "video", "audio", "document"].includes(message.messageType);
        const result = isMedia
            ? await (0, whatsapp_send_service_1.sendMediaMessage)({
                toPhone: message.toPhone,
                hotelId: message.hotelId,
                messageType: message.messageType,
                mediaUrl: message.mediaUrl,
                mimeType: message.mimeType,
                fileName: message.fileName ?? null,
                caption: message.body ?? null,
            })
            : await (0, whatsapp_send_service_1.sendTextMessage)({
                toPhone: message.toPhone,
                fromPhone: message.fromPhone,
                text: message.body,
                hotelId: message.hotelId,
                guestId: message.guestId ?? null,
            });
        // Store wamid if Meta returned one (null in mock mode)
        const wamid = result?.messages?.[0]?.id ?? undefined;
        await connect_1.default.message.update({
            where: { id: message.id },
            data: { status: client_1.MessageStatus.SENT, ...(wamid ? { wamid } : {}) },
        });
        // Notify dashboard via Redis → Socket.IO bridge
        (0, statusBus_1.publishMessageStatus)({
            hotelId: message.hotelId,
            messageId: message.id,
            status: client_1.MessageStatus.SENT,
        });
        console.log("✅ Message sent:", message.id);
    }
    catch (err) {
        await connect_1.default.message.update({
            where: { id: message.id },
            data: { status: client_1.MessageStatus.FAILED },
        });
        (0, statusBus_1.publishMessageStatus)({
            hotelId: message.hotelId,
            messageId: message.id,
            status: client_1.MessageStatus.FAILED,
        });
        console.error("❌ Message failed:", message.id);
        throw err; // BullMQ retry
    }
}, {
    connection: redis_1.redis,
    concurrency: 5,
});
//# sourceMappingURL=whatsapp.worker.js.map