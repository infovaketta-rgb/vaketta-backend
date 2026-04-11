"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrCreateSession = getOrCreateSession;
exports.updateSession = updateSession;
exports.resetSession = resetSession;
const connect_1 = __importDefault(require("../db/connect"));
async function getOrCreateSession(guestId, hotelId) {
    return connect_1.default.conversationSession.upsert({
        where: { guestId_hotelId: { guestId, hotelId } },
        update: {},
        create: { guestId, hotelId, state: "IDLE", data: {} },
    });
}
async function updateSession(guestId, hotelId, state, data = {}) {
    return connect_1.default.conversationSession.upsert({
        where: { guestId_hotelId: { guestId, hotelId } },
        update: { state, data: data },
        create: { guestId, hotelId, state, data: data },
    });
}
async function resetSession(guestId, hotelId) {
    return updateSession(guestId, hotelId, "IDLE", {});
}
//# sourceMappingURL=session.service.js.map