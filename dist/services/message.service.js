"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logIncomingMessage = logIncomingMessage;
exports.sendManualReply = sendManualReply;
const connect_1 = __importDefault(require("../db/connect"));
const whatsapp_queue_1 = require("../queue/whatsapp.queue");
const client_1 = require("@prisma/client");
const emit_1 = require("../realtime/emit");
const shouldAutoReply_1 = require("../automation/shouldAutoReply");
const botEngine_1 = require("../automation/botEngine");
const session_service_1 = require("./session.service");
const usage_service_1 = require("./usage.service");
async function logIncomingMessage(input) {
    const { fromPhone, toPhone, body, messageType, mediaUrl, mimeType, fileName } = input;
    /**
     * 1️⃣ Find hotel
     */
    const hotel = await connect_1.default.hotel.findUnique({
        where: { phone: toPhone },
        include: { config: true },
    });
    if (!hotel) {
        throw new Error(`Hotel not found for phone ${toPhone}`);
    }
    /**
     * 2️⃣ Find or create guest (scoped per hotel)
     */
    const guest = await connect_1.default.guest.upsert({
        where: {
            phone_hotelId: {
                phone: fromPhone,
                hotelId: hotel.id,
            },
        },
        update: {},
        create: {
            phone: fromPhone,
            hotelId: hotel.id,
        },
    });
    /**
     * 3️⃣ Save INCOMING message
     */
    const inMessage = await connect_1.default.message.create({
        data: {
            direction: "IN",
            fromPhone,
            toPhone,
            body: body ?? null,
            messageType,
            mediaUrl: mediaUrl ?? null,
            mimeType: mimeType ?? null,
            fileName: fileName ?? null,
            hotelId: hotel.id,
            guestId: guest.id,
            status: client_1.MessageStatus.RECEIVED,
        },
    });
    // 🔔 REAL-TIME EVENT
    (0, emit_1.emitToHotel)(hotel.id, "message:new", { message: inMessage });
    // 📊 USAGE — track every incoming message as a conversation unit (fire-and-forget)
    (0, usage_service_1.incrementConversationUsage)(hotel.id).catch(() => { });
    /**
     * 4️⃣ Create OUT message + enqueue (if auto-reply enabled)
     */
    /**
     * 4️⃣ Decide auto-reply mode (DAY / NIGHT / OFF)
     */
    if (!hotel.config) {
        return {
            hotelId: hotel.id,
            guestId: guest.id,
            autoReply: false,
            autoReplyMessage: null,
        };
    }
    /**
     * 4️⃣ Decide automation mode (Bug 4: pass timezone so hotel local time is used)
     */
    const autoReplyMode = (0, shouldAutoReply_1.shouldAutoReply)({
        autoReplyEnabled: hotel.config.autoReplyEnabled,
        businessStartHour: hotel.config.businessStartHour,
        businessEndHour: hotel.config.businessEndHour,
        timezone: hotel.config.timezone,
    }, guest.lastHandledByStaff);
    let sentReplyText = null;
    if (autoReplyMode === "DAY") {
        sentReplyText = await (0, botEngine_1.processMessage)(hotel.id, guest.id, body ?? null);
    }
    if (autoReplyMode === "NIGHT") {
        // Bug 6: NIGHT — send out-of-hours message, skip the menu entirely
        sentReplyText = hotel.config.nightMessage;
    }
    if (sentReplyText) {
        // 📊 USAGE — track each AI/bot reply
        (0, usage_service_1.incrementAIUsage)(hotel.id).catch(() => { });
        const outMessage = await connect_1.default.message.create({
            data: {
                direction: "OUT",
                fromPhone: toPhone,
                toPhone: fromPhone,
                body: sentReplyText,
                messageType: "text",
                hotelId: hotel.id,
                guestId: guest.id,
                status: client_1.MessageStatus.PENDING,
            },
        });
        (0, emit_1.emitToHotel)(hotel.id, "message:new", { message: outMessage });
        await whatsapp_queue_1.whatsappQueue.add("send", { messageId: outMessage.id });
    }
    /**
     * 5️⃣ Return context only (controller stays thin)
     */
    return {
        hotelId: hotel.id,
        guestId: guest.id,
        autoReply: autoReplyMode !== "OFF",
        autoReplyMessage: sentReplyText, // Bug 7: return actual reply sent, not welcomeMessage
    };
}
////////////////////////06-01-2026---00:22AM///////
async function sendManualReply(input) {
    const { hotelId, guestId, fromPhone, toPhone, text } = input;
    // 1️⃣ Mark guest as handled by staff — scoped to hotel to prevent cross-tenant update
    await connect_1.default.guest.updateMany({
        where: { id: guestId, hotelId },
        data: { lastHandledByStaff: true },
    });
    // Reset bot session so the conversation starts fresh after staff is done
    await (0, session_service_1.resetSession)(guestId, hotelId);
    // 1️⃣ Create OUT message as PENDING
    const message = await connect_1.default.message.create({
        data: {
            direction: "OUT",
            fromPhone,
            toPhone,
            body: text,
            messageType: "text",
            hotelId,
            guestId,
            status: client_1.MessageStatus.PENDING,
        },
    });
    (0, emit_1.emitToHotel)(input.hotelId, "message:new", {
        message,
    });
    // 2️⃣ Enqueue message
    await whatsapp_queue_1.whatsappQueue.add("send", {
        messageId: message.id
    });
    return message;
}
//# sourceMappingURL=message.service.js.map