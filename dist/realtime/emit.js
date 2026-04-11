"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitToGuest = emitToGuest;
exports.emitToHotel = emitToHotel;
// realtime/emit.ts
const server_1 = require("../server");
function emitToGuest(guestId, event, payload) {
    server_1.io.to(`guest:${guestId}`).emit(event, payload);
}
function emitToHotel(hotelId, event, payload) {
    server_1.io.to(`hotel:${hotelId}`).emit(event, payload);
}
//# sourceMappingURL=emit.js.map