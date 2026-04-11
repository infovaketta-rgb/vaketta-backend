"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyWhatsAppWebhook = verifyWhatsAppWebhook;
exports.handleWhatsAppWebhook = handleWhatsAppWebhook;
const message_service_1 = require("../services/message.service");
const phone_1 = require("../utils/phone");
const connect_1 = __importDefault(require("../db/connect"));
const client_1 = require("@prisma/client");
const emit_1 = require("../realtime/emit");
const media_service_1 = require("../services/media.service");
const META_STATUS_MAP = {
    sent: client_1.MessageStatus.SENT,
    delivered: client_1.MessageStatus.DELIVERED,
    read: client_1.MessageStatus.READ,
    failed: client_1.MessageStatus.FAILED,
};
// Bug 1: GET handler for Meta webhook verification challenge
function verifyWhatsAppWebhook(req, res) {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (mode === "subscribe" && token === expectedToken) {
        console.log("✅ WhatsApp webhook verified");
        return res.status(200).send(challenge);
    }
    console.warn("❌ WhatsApp webhook verification failed", { mode, token });
    return res.sendStatus(403);
}
async function handleWhatsAppWebhook(req, res) {
    try {
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        // Handle Meta status updates (sent / delivered / read / failed)
        const statusUpdate = value?.statuses?.[0];
        if (statusUpdate) {
            const wamid = statusUpdate.id;
            const metaStatus = statusUpdate.status;
            const newStatus = metaStatus ? META_STATUS_MAP[metaStatus] : undefined;
            if (wamid && newStatus) {
                const updated = await connect_1.default.message.findFirst({ where: { wamid } });
                if (updated) {
                    await connect_1.default.message.update({
                        where: { id: updated.id },
                        data: { status: newStatus },
                    });
                    (0, emit_1.emitToHotel)(updated.hotelId, "message:status", {
                        messageId: updated.id,
                        status: newStatus,
                    });
                }
            }
            return res.sendStatus(200);
        }
        // Handle incoming guest messages
        const message = value?.messages?.[0];
        if (!message) {
            return res.sendStatus(200);
        }
        const rawFrom = message.from;
        const rawTo = value?.metadata?.display_phone_number;
        if (!rawFrom || !rawTo) {
            console.warn("⚠️ Missing phone numbers in webhook payload", { rawFrom, rawTo });
            return res.sendStatus(200);
        }
        const fromPhone = (0, phone_1.normalizePhone)(rawFrom);
        const toPhone = (0, phone_1.normalizePhone)(rawTo);
        const messageType = message.type || "text";
        // Extract text body (text messages) or caption (media messages)
        const body = message.text?.body ?? message[messageType]?.caption ?? null;
        // Download media if this is a media message
        let mediaUrl = null;
        let mimeType = null;
        let fileName = null;
        const mediaInfo = (0, media_service_1.extractMediaFromWebhookMessage)(message);
        if (mediaInfo) {
            const downloaded = await (0, media_service_1.downloadMetaMedia)(mediaInfo.mediaId, mediaInfo.mimeType, mediaInfo.fileName ?? undefined);
            if (downloaded) {
                mediaUrl = downloaded.localUrl;
                mimeType = downloaded.mimeType;
                fileName = downloaded.fileName;
            }
            else {
                // No credentials — store mediaId as placeholder so type info is preserved
                mediaUrl = `meta://${mediaInfo.mediaId}`;
                mimeType = mediaInfo.mimeType;
                fileName = mediaInfo.fileName;
            }
        }
        await (0, message_service_1.logIncomingMessage)({ fromPhone, toPhone, body, messageType, mediaUrl, mimeType, fileName });
        return res.sendStatus(200);
    }
    catch (err) {
        console.error("❌ WhatsApp webhook error:", err);
        return res.sendStatus(200); // always ACK to prevent Meta retries
    }
}
//# sourceMappingURL=whatsapp.controller.js.map