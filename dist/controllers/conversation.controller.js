"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConversations = getConversations;
const connect_1 = __importDefault(require("../db/connect"));
const client_1 = require("@prisma/client");
async function getConversations(req, res) {
    try {
        const user = req.user;
        const hotelId = user?.hotelId;
        if (!hotelId) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const guests = await connect_1.default.guest.findMany({
            where: {
                hotelId: hotelId,
            },
            include: {
                messages: {
                    orderBy: { timestamp: "desc" },
                    take: 1,
                },
            },
        });
        const result = await Promise.all(guests.map(async (guest) => {
            const lastMessage = guest.messages[0];
            const unreadCount = await connect_1.default.message.count({
                where: {
                    hotelId: hotelId,
                    guestId: guest.id,
                    direction: "IN",
                    status: client_1.MessageStatus.RECEIVED,
                },
            });
            return {
                guestId: guest.id,
                phone: guest.phone,
                lastHandledByStaff: guest.lastHandledByStaff,
                lastMessage: lastMessage?.body ?? null,
                lastMessageType: lastMessage?.messageType ?? null,
                lastDirection: lastMessage?.direction ?? null,
                lastTimestamp: lastMessage?.timestamp ?? null,
                unreadCount,
            };
        }));
        // ✅ Sort by latest message timestamp — newest first
        result.sort((a, b) => {
            if (!a.lastTimestamp)
                return 1;
            if (!b.lastTimestamp)
                return -1;
            return new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime();
        });
        return res.json(result);
    }
    catch (err) {
        console.error("❌ Get conversations failed:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
//# sourceMappingURL=conversation.controller.js.map